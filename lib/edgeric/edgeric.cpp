#include "edgeric.h"
#include <set>
#include <algorithm>
#include <chrono>

//==============================================================================
// Static Member Definitions
//==============================================================================

// TTI counter
uint32_t edgeric::tti_cnt = 0;
uint64_t edgeric::native_slot = 0;
uint32_t edgeric::numerology = 0;
uint32_t edgeric::slot_duration_ns = 1000000;
bool edgeric::native_slot_initialized = false;
uint32_t edgeric::last_native_slot_mod = 0;
uint32_t edgeric::native_slot_modulus = 0;

// Control indices
uint32_t edgeric::er_ran_index_weights = 0;
uint32_t edgeric::er_ran_index_mcs = 0;

// TTI tracking for staleness check
uint32_t edgeric::er_weights_tti = 0;
uint32_t edgeric::er_mcs_tti = 0;

// Logging flag
bool edgeric::enable_logging = false;
bool edgeric::initialized = false;

// Control maps
std::map<uint16_t, float> edgeric::weights_recved = {};
std::map<uint16_t, uint8_t> edgeric::mcs_recved = {};
std::set<uint16_t> edgeric::dl_eligible_rntis = {};
std::set<uint16_t> edgeric::ul_eligible_rntis = {};
bool edgeric::eligibility_mode = false;
uint64_t edgeric::eligibility_decision_slot = 0;
uint64_t edgeric::scheduler_policy_epoch = 0;
std::string edgeric::scheduler_algorithm = {};

// MAC metrics
std::map<uint16_t, mac_ue_metrics> edgeric::mac_ue = {};
std::map<ue_drb_key, mac_drb_metrics> edgeric::mac_drb = {};
std::vector<harq_event_data> edgeric::pending_harq_events = {};
uint64_t edgeric::next_harq_event_sequence = 0;

// RLC metrics
std::map<ue_drb_key, rlc_drb_metrics> edgeric::rlc_drb = {};
std::mutex edgeric::rlc_mutex;

// PDCP metrics
std::map<edgeric::cu_up_drb_key, pdcp_drb_metrics> edgeric::pdcp_drb = {};
std::mutex edgeric::pdcp_mutex;

// GTP metrics
std::map<uint32_t, gtp_ue_metrics> edgeric::gtp_ue = {};
std::mutex edgeric::gtp_mutex;

// UE ID correlation maps
std::map<uint32_t, uint16_t> edgeric::ue_index_to_rnti = {};
std::map<uint32_t, uint16_t> edgeric::e1ap_id_to_rnti = {};
std::map<uint32_t, uint32_t> edgeric::cu_up_ue_to_e1ap_id = {};
std::map<uint32_t, uint16_t> edgeric::du_ue_to_rnti = {};
std::mutex edgeric::du_ue_mutex;

//==============================================================================
// ZMQ Sockets (file-scope)
//==============================================================================

static zmq::context_t context(1);
static zmq::socket_t publisher(context, ZMQ_PUB);
static zmq::socket_t subscriber_weights(context, ZMQ_SUB);
static zmq::socket_t subscriber_mcs(context, ZMQ_SUB);
static uint64_t next_message_sequence = 0;
static uint64_t dropped_harq_events = 0;
static constexpr size_t MAX_PENDING_HARQ_EVENTS = 65536;

//==============================================================================
// Initialization
//==============================================================================

void edgeric::init() {
    if (initialized) return;
    
    // Keep a bounded, non-conflated queue. The scheduler still uses non-blocking
    // sends, and message/event sequence gaps make overload loss observable.
    publisher.set(zmq::sockopt::sndhwm, 10000);
    publisher.bind("ipc:///tmp/metrics_data");
    
    // Subscriber for weights
    subscriber_weights.connect("ipc:///tmp/control_weights");
    subscriber_weights.set(zmq::sockopt::subscribe, "");
    subscriber_weights.set(zmq::sockopt::conflate, 1);

    // Subscriber for MCS
    subscriber_mcs.connect("ipc:///tmp/control_mcs");
    subscriber_mcs.set(zmq::sockopt::subscribe, "");
    subscriber_mcs.set(zmq::sockopt::conflate, 1);

    initialized = true;
}

void edgeric::ensure_initialized() {
    if (!initialized) {
        init();
    }
}

//==============================================================================
// MAC Metrics (scheduler thread - no locking)
//==============================================================================

namespace {

constexpr uint64_t extend_modular_slot_near(uint64_t reference_extended,
                                            uint32_t reference_modular,
                                            uint32_t modulus,
                                            uint32_t target_modular)
{
    int64_t delta = static_cast<int64_t>(target_modular) - static_cast<int64_t>(reference_modular);
    const int64_t half_modulus = static_cast<int64_t>(modulus / 2U);
    if (delta > half_modulus) {
        delta -= modulus;
    } else if (delta < -half_modulus) {
        delta += modulus;
    }
    return static_cast<uint64_t>(static_cast<int64_t>(reference_extended) + delta);
}

constexpr uint32_t forward_modular_delta(uint32_t previous, uint32_t current, uint32_t modulus)
{
    return (current + modulus - previous) % modulus;
}

static_assert(extend_modular_slot_near(20482, 2, 20480, 20479) == 20479);
static_assert(extend_modular_slot_near(20479, 20479, 20480, 2) == 20482);
static_assert(extend_modular_slot_near(1234, 1234, 20480, 1200) == 1200);
static_assert(forward_modular_delta(20479, 0, 20480) == 1);
static_assert(forward_modular_delta(20470, 5, 20480) == 15);
static_assert(forward_modular_delta(100, 100, 20480) == 0);

} // namespace

void edgeric::setTTI(uint32_t tti_count,
                     uint32_t modular_slot,
                     uint32_t slot_modulus,
                     uint32_t numerology_value)
{
    tti_cnt = tti_count;
    numerology = numerology_value;
    slot_duration_ns = 1000000U >> numerology_value;

    if (not native_slot_initialized) {
        native_slot = modular_slot;
        native_slot_initialized = true;
    } else if (slot_modulus != native_slot_modulus) {
        // A cell's numerology is stable for its lifetime. If this process is
        // reused for a different modulus, preserve monotonicity and start a new
        // local epoch; an exact cross-cell/reconfiguration delta is unknowable.
        ++native_slot;
    } else {
        const uint32_t forward_delta = forward_modular_delta(last_native_slot_mod, modular_slot, slot_modulus);
        native_slot += forward_delta;
    }

    last_native_slot_mod = modular_slot;
    native_slot_modulus = slot_modulus;
}

uint64_t edgeric::extend_recent_slot(uint32_t modular_slot)
{
    if (not native_slot_initialized or native_slot_modulus == 0) {
        return modular_slot;
    }
    return extend_modular_slot_near(native_slot, last_native_slot_mod, native_slot_modulus, modular_slot);
}

void edgeric::set_mac_ue(uint16_t rnti, uint32_t cqi, float snr,
                         uint32_t dl_buffer, uint32_t ul_buffer,
                         uint32_t dl_tbs, uint32_t ul_tbs) {
    auto& m = mac_ue[rnti];
    m.cqi = cqi;
    m.snr = snr;
    m.dl_buffer = dl_buffer;
    m.ul_buffer = ul_buffer;
    m.dl_tbs = dl_tbs;
    m.ul_tbs = ul_tbs;
}

void edgeric::record_harq_event(uint32_t cell_index,
                                uint32_t du_ue_index,
                                uint16_t rnti,
                                HarqDirection direction,
                                uint32_t tx_slot,
                                uint32_t feedback_slot,
                                uint32_t harq_id,
                                uint32_t attempt_number,
                                bool ndi,
                                HarqOutcome outcome,
                                uint32_t tbs_bytes) {
    const uint64_t sequence_id = next_harq_event_sequence++;
    if (pending_harq_events.size() >= MAX_PENDING_HARQ_EVENTS) {
        ++dropped_harq_events;
        if (dropped_harq_events == 1 or (dropped_harq_events & (dropped_harq_events - 1)) == 0) {
            std::cerr << "EdgeRIC HARQ event queue saturated; dropped " << dropped_harq_events
                      << " terminal events (event sequence gaps will expose loss)\n";
        }
        return;
    }
    pending_harq_events.push_back(harq_event_data{
        sequence_id,
        cell_index,
        du_ue_index,
        rnti,
        direction,
        extend_recent_slot(tx_slot),
        extend_recent_slot(feedback_slot),
        harq_id,
        attempt_number,
        ndi,
        outcome,
        tbs_bytes});
}

void edgeric::set_mac_drb(uint16_t rnti, uint8_t lcid,
                          uint32_t dl_buffer, uint32_t ul_buffer,
                          uint32_t dl_bytes, uint32_t ul_bytes) {
    auto& m = mac_drb[{rnti, lcid}];
    m.dl_buffer = dl_buffer;
    m.ul_buffer = ul_buffer;
    m.dl_bytes = dl_bytes;
    m.ul_bytes = ul_bytes;
}

void edgeric::add_mac_drb_dl_bytes(uint16_t rnti, uint8_t lcid, uint32_t bytes) {
    mac_drb[{rnti, lcid}].dl_bytes += bytes;
}

void edgeric::add_mac_drb_ul_bytes(uint16_t rnti, uint8_t lcid, uint32_t bytes) {
    mac_drb[{rnti, lcid}].ul_bytes += bytes;
}

void edgeric::set_tx_bytes(uint16_t rnti, float tbs) {
    mac_ue[rnti].dl_tbs += static_cast<uint32_t>(tbs);
}

void edgeric::set_rx_bytes(uint16_t rnti, float tbs) {
    mac_ue[rnti].ul_tbs += static_cast<uint32_t>(tbs);
}

void edgeric::set_dl_tbs(uint16_t rnti, uint32_t tbs) {
    mac_ue[rnti].dl_tbs += tbs;  // ACCUMULATE instead of overwrite!
}

void edgeric::set_ul_tbs(uint16_t rnti, uint32_t tbs) {
    mac_ue[rnti].ul_tbs += tbs;  // Accumulate
}

void edgeric::set_dl_mcs(uint16_t rnti, uint32_t mcs) {
    // Use max - multiple allocations may use different MCS
    if (mcs > mac_ue[rnti].dl_mcs) mac_ue[rnti].dl_mcs = mcs;
}

void edgeric::set_ul_mcs(uint16_t rnti, uint32_t mcs) {
    if (mcs > mac_ue[rnti].ul_mcs) mac_ue[rnti].ul_mcs = mcs;
}

void edgeric::set_dl_prbs(uint16_t rnti, uint32_t prbs) {
    mac_ue[rnti].dl_prbs += prbs;  // Accumulate
}

void edgeric::set_ul_prbs(uint16_t rnti, uint32_t prbs) {
    mac_ue[rnti].ul_prbs += prbs;  // Accumulate
}

void edgeric::report_mac_delays(uint16_t rnti,
                                std::optional<float> avg_ce_delay_ms,
                                std::optional<float> avg_crc_delay_ms,
                                std::optional<float> avg_pucch_harq_delay_ms,
                                std::optional<float> avg_pusch_harq_delay_ms,
                                std::optional<float> avg_sr_to_pusch_delay_ms) {
    auto& m = mac_ue[rnti];
    m.avg_ce_delay_ms = avg_ce_delay_ms;
    m.avg_crc_delay_ms = avg_crc_delay_ms;
    m.avg_pucch_harq_delay_ms = avg_pucch_harq_delay_ms;
    m.avg_pusch_harq_delay_ms = avg_pusch_harq_delay_ms;
    m.avg_sr_to_pusch_delay_ms = avg_sr_to_pusch_delay_ms;
}

//==============================================================================
// RLC Metrics (RLC thread - needs locking)
//==============================================================================

void edgeric::report_rlc_metrics(uint32_t du_ue_index, uint8_t lcid,
                                 const rlc_drb_metrics& metrics) {
    std::lock_guard<std::mutex> lock(rlc_mutex);
    
    // Look up RNTI from DU UE index
    auto it = du_ue_to_rnti.find(du_ue_index);
    if (it == du_ue_to_rnti.end()) return;
    
    uint16_t rnti = it->second;
    rlc_drb[{rnti, lcid}] = metrics;
}

void edgeric::register_du_ue(uint32_t du_ue_index, uint16_t rnti) {
    std::lock_guard<std::mutex> lock(du_ue_mutex);
    du_ue_to_rnti[du_ue_index] = rnti;
}

//==============================================================================
// PDCP Metrics (CU-UP thread - needs locking)
//==============================================================================

void edgeric::report_pdcp_metrics(uint32_t cu_up_ue_index, uint8_t drb_id,
                                  const pdcp_drb_metrics& metrics) {
    std::lock_guard<std::mutex> lock(pdcp_mutex);
    pdcp_drb[{cu_up_ue_index, drb_id}] = metrics;
}

//==============================================================================
// GTP Metrics (CU-UP thread - needs locking)
//==============================================================================

void edgeric::report_gtp_dl_pkt(uint32_t cu_up_ue_index, uint32_t pdu_len) {
    std::lock_guard<std::mutex> lock(gtp_mutex);
    auto& m = gtp_ue[cu_up_ue_index];
    m.dl_pkts++;
    m.dl_bytes += pdu_len;
}

void edgeric::report_gtp_ul_pkt(uint32_t cu_up_ue_index, uint32_t pdu_len) {
    std::lock_guard<std::mutex> lock(gtp_mutex);
    auto& m = gtp_ue[cu_up_ue_index];
    m.ul_pkts++;
    m.ul_bytes += pdu_len;
}

//==============================================================================
// UE ID Correlation
//==============================================================================

void edgeric::register_ue(uint32_t ue_index, uint16_t rnti) {
    ue_index_to_rnti[ue_index] = rnti;
}

void edgeric::unregister_ue(uint32_t ue_index) {
    ue_index_to_rnti.erase(ue_index);
}

void edgeric::unregister_ue_by_rnti(uint16_t rnti) {
    // Clean up MAC UE metrics
    mac_ue.erase(rnti);
    
    // Clean up MAC DRB metrics for this RNTI
    for (auto it = mac_drb.begin(); it != mac_drb.end(); ) {
        if (it->first.first == rnti) {
            it = mac_drb.erase(it);
        } else {
            ++it;
        }
    }
    
    // Clean up RLC DRB metrics for this RNTI (with lock)
    {
        std::lock_guard<std::mutex> lock(rlc_mutex);
        for (auto it = rlc_drb.begin(); it != rlc_drb.end(); ) {
            if (it->first.first == rnti) {
                it = rlc_drb.erase(it);
            } else {
                ++it;
            }
        }
    }
    
    // Clean up ue_index_to_rnti entries pointing to this RNTI
    for (auto it = ue_index_to_rnti.begin(); it != ue_index_to_rnti.end(); ) {
        if (it->second == rnti) {
            it = ue_index_to_rnti.erase(it);
        } else {
            ++it;
        }
    }
    
    // Clean up DU UE to RNTI mapping (with lock)
    {
        std::lock_guard<std::mutex> lock(du_ue_mutex);
        for (auto it = du_ue_to_rnti.begin(); it != du_ue_to_rnti.end(); ) {
            if (it->second == rnti) {
                it = du_ue_to_rnti.erase(it);
            } else {
                ++it;
            }
        }
    }
    
    // Clean up E1AP to RNTI mapping and collect e1ap_ids to remove
    std::vector<uint32_t> e1ap_ids_to_remove;
    for (auto it = e1ap_id_to_rnti.begin(); it != e1ap_id_to_rnti.end(); ) {
        if (it->second == rnti) {
            e1ap_ids_to_remove.push_back(it->first);
            it = e1ap_id_to_rnti.erase(it);
        } else {
            ++it;
        }
    }
    
    // Clean up cu_up_ue_to_e1ap_id and collect cu_up_ue_indices to clean up PDCP/GTP
    std::vector<uint32_t> cu_up_indices_to_remove;
    for (auto it = cu_up_ue_to_e1ap_id.begin(); it != cu_up_ue_to_e1ap_id.end(); ) {
        bool should_remove = false;
        for (uint32_t e1ap_id : e1ap_ids_to_remove) {
            if (it->second == e1ap_id) {
                should_remove = true;
                break;
            }
        }
        if (should_remove) {
            cu_up_indices_to_remove.push_back(it->first);
            it = cu_up_ue_to_e1ap_id.erase(it);
        } else {
            ++it;
        }
    }
    
    // Clean up PDCP metrics for the CU-UP UE indices (with lock)
    {
        std::lock_guard<std::mutex> lock(pdcp_mutex);
        for (auto it = pdcp_drb.begin(); it != pdcp_drb.end(); ) {
            bool should_remove = false;
            for (uint32_t cu_up_idx : cu_up_indices_to_remove) {
                if (it->first.first == cu_up_idx) {
                    should_remove = true;
                    break;
                }
            }
            if (should_remove) {
                it = pdcp_drb.erase(it);
            } else {
                ++it;
            }
        }
    }
    
    // Clean up GTP metrics for the CU-UP UE indices (with lock)
    {
        std::lock_guard<std::mutex> lock(gtp_mutex);
        for (uint32_t cu_up_idx : cu_up_indices_to_remove) {
            gtp_ue.erase(cu_up_idx);
        }
    }
}

uint16_t edgeric::get_rnti_from_ue_index(uint32_t ue_index) {
    auto it = ue_index_to_rnti.find(ue_index);
    return (it != ue_index_to_rnti.end()) ? it->second : 0;
}

void edgeric::register_e1ap_rnti(uint32_t e1ap_id, uint16_t rnti) {
    e1ap_id_to_rnti[e1ap_id] = rnti;
}

void edgeric::register_cu_up_ue_e1ap(uint32_t cu_up_ue_index, uint32_t e1ap_id) {
    cu_up_ue_to_e1ap_id[cu_up_ue_index] = e1ap_id;
}

uint16_t edgeric::get_rnti_from_cu_up_ue_index(uint32_t cu_up_ue_index) {
    // Try E1AP correlation first
    auto it1 = cu_up_ue_to_e1ap_id.find(cu_up_ue_index);
    if (it1 != cu_up_ue_to_e1ap_id.end()) {
        auto it2 = e1ap_id_to_rnti.find(it1->second);
        if (it2 != e1ap_id_to_rnti.end()) {
            return it2->second;
        }
    }
    
    // Fallback 1: Try ue_index_to_rnti (CU-CP)
    if (!ue_index_to_rnti.empty()) {
        std::vector<std::pair<uint32_t, uint16_t>> sorted_ues(
            ue_index_to_rnti.begin(), ue_index_to_rnti.end());
        std::sort(sorted_ues.begin(), sorted_ues.end());
        
        if (cu_up_ue_index < sorted_ues.size()) {
            return sorted_ues[cu_up_ue_index].second;
        }
    }
    
    // Fallback 2: Try mac_ue (scheduler - indexed by RNTI directly)
    if (!mac_ue.empty()) {
        std::vector<uint16_t> sorted_rntis;
        for (const auto& [rnti, _] : mac_ue) {
            sorted_rntis.push_back(rnti);
        }
        std::sort(sorted_rntis.begin(), sorted_rntis.end());
        
        if (cu_up_ue_index < sorted_rntis.size()) {
            return sorted_rntis[cu_up_ue_index];
        }
    }
    
    return 0;
}

//==============================================================================
// Per-TTI Metrics Export (main function)
//==============================================================================

void edgeric::send_tti_metrics() {
    ensure_initialized();
    
    // Build TtiMetrics protobuf message
    // Use raw tti_cnt (not modulo'd) for accurate staleness checking
    TtiMetrics tti_msg;
    tti_msg.set_tti_index(tti_cnt);
    tti_msg.set_native_slot(native_slot);
    tti_msg.set_numerology(numerology);
    tti_msg.set_slot_duration_ns(slot_duration_ns);
    tti_msg.set_message_sequence_id(next_message_sequence++);
    const bool control_active = eligibility_control_active();
    tti_msg.set_scheduler_control_active(control_active);
    if (control_active) {
        tti_msg.set_scheduler_policy_epoch(scheduler_policy_epoch);
        tti_msg.set_scheduler_algorithm(scheduler_algorithm);
        for (uint16_t rnti : dl_eligible_rntis) tti_msg.add_dl_eligible_rntis(rnti);
        for (uint16_t rnti : ul_eligible_rntis) tti_msg.add_ul_eligible_rntis(rnti);
    } else {
        tti_msg.set_scheduler_algorithm("Native scheduler (fail-open)");
    }
    
    // Timestamp in microseconds
    auto now = std::chrono::system_clock::now();
    auto us = std::chrono::duration_cast<std::chrono::microseconds>(
        now.time_since_epoch()).count();
    tti_msg.set_timestamp_us(static_cast<uint64_t>(us));

    for (const harq_event_data& event : pending_harq_events) {
        HarqEvent* event_msg = tti_msg.add_harq_events();
        event_msg->set_sequence_id(event.sequence_id);
        event_msg->set_cell_index(event.cell_index);
        event_msg->set_du_ue_index(event.du_ue_index);
        event_msg->set_rnti(event.rnti);
        event_msg->set_direction(event.direction);
        event_msg->set_tx_slot(event.tx_slot);
        event_msg->set_feedback_slot(event.feedback_slot);
        event_msg->set_harq_id(event.harq_id);
        event_msg->set_attempt_number(event.attempt_number);
        event_msg->set_is_retransmission(event.attempt_number > 0);
        event_msg->set_ndi(event.ndi);
        event_msg->set_outcome(event.outcome);
        event_msg->set_tbs_bytes(event.tbs_bytes);
    }
    
    // Collect unique RNTIs from MAC metrics
    std::set<uint16_t> active_rntis;
    for (const auto& [rnti, _] : mac_ue) {
        active_rntis.insert(rnti);
    }
    
    // Build per-UE metrics
    for (uint16_t rnti : active_rntis) {
        UeMetrics* ue_msg = tti_msg.add_ues();
        ue_msg->set_rnti(rnti);
        
        // MAC aggregate metrics
        auto mac_it = mac_ue.find(rnti);
        if (mac_it != mac_ue.end()) {
            MacUeMetrics* mac_msg = ue_msg->mutable_mac();
            mac_msg->set_cqi(mac_it->second.cqi);
            mac_msg->set_snr(mac_it->second.snr);
            mac_msg->set_dl_buffer(mac_it->second.dl_buffer);
            mac_msg->set_ul_buffer(mac_it->second.ul_buffer);
            mac_msg->set_dl_tbs(mac_it->second.dl_tbs);
            mac_msg->set_ul_tbs(mac_it->second.ul_tbs);
            mac_msg->set_dl_acked_bytes(mac_it->second.dl_acked_bytes);
            mac_msg->set_ul_ok_bytes(mac_it->second.ul_ok_bytes);
            mac_msg->set_dl_mcs(mac_it->second.dl_mcs);
            mac_msg->set_ul_mcs(mac_it->second.ul_mcs);
            mac_msg->set_dl_prbs(mac_it->second.dl_prbs);
            mac_msg->set_ul_prbs(mac_it->second.ul_prbs);
            mac_msg->set_dl_harq_ack(mac_it->second.dl_harq_ack);
            mac_msg->set_dl_harq_nack(mac_it->second.dl_harq_nack);
            mac_msg->set_ul_crc_ok(mac_it->second.ul_crc_ok);
            mac_msg->set_ul_crc_fail(mac_it->second.ul_crc_fail);
            // MAC layer delays in ms
            if (mac_it->second.avg_ce_delay_ms.has_value()) {
                mac_msg->set_avg_ce_delay_ms(mac_it->second.avg_ce_delay_ms.value());
            }
            if (mac_it->second.avg_crc_delay_ms.has_value()) {
                mac_msg->set_avg_crc_delay_ms(mac_it->second.avg_crc_delay_ms.value());
            }
            if (mac_it->second.avg_pucch_harq_delay_ms.has_value()) {
                mac_msg->set_avg_pucch_harq_delay_ms(mac_it->second.avg_pucch_harq_delay_ms.value());
            }
            if (mac_it->second.avg_pusch_harq_delay_ms.has_value()) {
                mac_msg->set_avg_pusch_harq_delay_ms(mac_it->second.avg_pusch_harq_delay_ms.value());
            }
            if (mac_it->second.avg_sr_to_pusch_delay_ms.has_value()) {
                mac_msg->set_avg_sr_to_pusch_delay_ms(mac_it->second.avg_sr_to_pusch_delay_ms.value());
            }
        }
        
        // MAC per-DRB metrics
        for (const auto& [key, drb] : mac_drb) {
            if (key.first != rnti) continue;
            
            MacDrbMetrics* drb_msg = ue_msg->add_mac_drb();
            drb_msg->set_lcid(key.second);
            drb_msg->set_dl_buffer(drb.dl_buffer);
            drb_msg->set_ul_buffer(drb.ul_buffer);
            drb_msg->set_dl_bytes(drb.dl_bytes);
            drb_msg->set_ul_bytes(drb.ul_bytes);
        }
        
        // RLC per-DRB metrics (with lock)
        {
            std::lock_guard<std::mutex> lock(rlc_mutex);
            for (const auto& [key, rlc] : rlc_drb) {
                if (key.first != rnti) continue;
                
                RlcDrbMetrics* rlc_msg = ue_msg->add_rlc_drb();
                rlc_msg->set_lcid(key.second);
                // Buffer status
                rlc_msg->set_dl_buffer(rlc.dl_buffer);
                rlc_msg->set_ul_buffer(rlc.ul_buffer);
                // TX (DL) metrics
                rlc_msg->set_tx_sdus(rlc.tx_sdus);
                rlc_msg->set_tx_sdu_bytes(rlc.tx_sdu_bytes);
                rlc_msg->set_tx_pdus(rlc.tx_pdus);
                rlc_msg->set_tx_pdu_bytes(rlc.tx_pdu_bytes);
                rlc_msg->set_tx_dropped_sdus(rlc.tx_dropped_sdus);
                rlc_msg->set_tx_retx_pdus(rlc.tx_retx_pdus);
                rlc_msg->set_tx_sdu_latency_us(rlc.tx_sdu_latency_us);
                // RX (UL) metrics
                rlc_msg->set_rx_sdus(rlc.rx_sdus);
                rlc_msg->set_rx_sdu_bytes(rlc.rx_sdu_bytes);
                rlc_msg->set_rx_pdus(rlc.rx_pdus);
                rlc_msg->set_rx_pdu_bytes(rlc.rx_pdu_bytes);
                rlc_msg->set_rx_lost_pdus(rlc.rx_lost_pdus);
                rlc_msg->set_rx_sdu_latency_us(rlc.rx_sdu_latency_us);
            }
        }
        
        // PDCP per-DRB metrics (with lock, need to correlate CU-UP UE index)
        {
            std::lock_guard<std::mutex> lock(pdcp_mutex);
            for (const auto& [key, pdcp] : pdcp_drb) {
                uint16_t pdcp_rnti = get_rnti_from_cu_up_ue_index(key.first);
                if (pdcp_rnti != rnti) continue;
                
                PdcpDrbMetrics* pdcp_msg = ue_msg->add_pdcp_drb();
                pdcp_msg->set_drb_id(key.second);
                pdcp_msg->set_lcid(key.second + 3);  // LCID = DRB_ID + 3
                // TX (DL) metrics
                pdcp_msg->set_tx_pdus(pdcp.tx_pdus);
                pdcp_msg->set_tx_pdu_bytes(pdcp.tx_pdu_bytes);
                pdcp_msg->set_tx_sdus(pdcp.tx_sdus);
                pdcp_msg->set_tx_dropped_sdus(pdcp.tx_dropped_sdus);
                pdcp_msg->set_tx_discard_timeouts(pdcp.tx_discard_timeouts);
                pdcp_msg->set_tx_pdu_latency_ns(pdcp.tx_pdu_latency_ns);
                // RX (UL) metrics
                pdcp_msg->set_rx_pdus(pdcp.rx_pdus);
                pdcp_msg->set_rx_pdu_bytes(pdcp.rx_pdu_bytes);
                pdcp_msg->set_rx_delivered_sdus(pdcp.rx_delivered_sdus);
                pdcp_msg->set_rx_dropped_pdus(pdcp.rx_dropped_pdus);
                pdcp_msg->set_rx_sdu_latency_ns(pdcp.rx_sdu_latency_ns);
            }
        }
        
        // GTP metrics per UE (with lock)
        {
            std::lock_guard<std::mutex> lock(gtp_mutex);
            for (const auto& [cu_up_idx, gtp] : gtp_ue) {
                uint16_t gtp_rnti = get_rnti_from_cu_up_ue_index(cu_up_idx);
                if (gtp_rnti != rnti) continue;
                
                GtpMetrics* gtp_msg = ue_msg->mutable_gtp();
                gtp_msg->set_dl_pkts(gtp.dl_pkts);
                gtp_msg->set_dl_bytes(gtp.dl_bytes);
                gtp_msg->set_ul_pkts(gtp.ul_pkts);
                gtp_msg->set_ul_bytes(gtp.ul_bytes);
                break;  // One GTP entry per UE
            }
        }
    }
    
    // Serialize and send via ZMQ
    std::string serialized;
    tti_msg.SerializeToString(&serialized);
    
    zmq::message_t msg(serialized.data(), serialized.size());
    const auto send_result = publisher.send(msg, zmq::send_flags::dontwait);

    // Retain terminal outcomes if ZeroMQ could not enqueue this non-blocking
    // send. The next publish retries them unchanged; message sequence gaps make
    // the failed frame visible without creating event sequence gaps.
    if (send_result.has_value()) {
        pending_harq_events.clear();
    }
    
    // Reset per-TTI MAC counters (HARQ, scheduling info)
    // Note: MAC delays are NOT reset here as they are updated per-report-period
    for (auto& [rnti, m] : mac_ue) {
        m.dl_harq_ack = 0;
        m.dl_harq_nack = 0;
        m.ul_crc_ok = 0;
        m.ul_crc_fail = 0;
        m.dl_tbs = 0;
        m.ul_tbs = 0;
        m.dl_acked_bytes = 0;  // Reset goodput counters
        m.ul_ok_bytes = 0;
        m.dl_mcs = 0;
        m.ul_mcs = 0;
        m.dl_prbs = 0;
        m.ul_prbs = 0;
    }
    for (auto& [key, m] : mac_drb) {
        m.dl_bytes = 0;
        m.ul_bytes = 0;
    }
}

//==============================================================================
// Legacy API: send_to_er (calls new send_tti_metrics)
//==============================================================================

void edgeric::send_to_er() {
    send_tti_metrics();
}

//==============================================================================
// Legacy API: printmyvariables
//==============================================================================

void edgeric::printmyvariables() {
    if (!enable_logging) return;
    
    std::ofstream logfile("log.txt", std::ios_base::app);
    if (!logfile.is_open()) return;
    
    logfile << "\n========== TTI " << getTtiIndex() << " (raw=" << tti_cnt << ") ==========\n";
    
    // Print per-UE metrics
    for (const auto& [rnti, m] : mac_ue) {
        logfile << "UE RNTI=" << rnti 
                << " CQI=" << m.cqi << " SNR=" << m.snr
                << " DL_BUF=" << m.dl_buffer << " UL_BUF=" << m.ul_buffer
                << " DL_TBS=" << m.dl_tbs << " UL_TBS=" << m.ul_tbs
                << " DL_ACK=" << m.dl_harq_ack << " DL_NACK=" << m.dl_harq_nack
                << " UL_OK=" << m.ul_crc_ok << " UL_FAIL=" << m.ul_crc_fail
                << "\n";
        
        // MAC DRBs (LCID >= 4 are DRBs; 0-3 are SRBs)
        for (const auto& [key, drb] : mac_drb) {
            if (key.first != rnti) continue;
            if (key.second < 4) continue;  // Skip SRBs
            logfile << "  MAC DRB LCID=" << (int)key.second
                    << " dl_buf=" << drb.dl_buffer << " ul_buf=" << drb.ul_buffer
                    << " dl_bytes=" << drb.dl_bytes << " ul_bytes=" << drb.ul_bytes
                    << "\n";
        }
        
        // RLC DRBs
        {
            std::lock_guard<std::mutex> lock(rlc_mutex);
            for (const auto& [key, rlc] : rlc_drb) {
                if (key.first != rnti) continue;
                logfile << "  RLC DRB LCID=" << (int)key.second
                        << " tx_sdus=" << rlc.tx_sdus << " tx_bytes=" << rlc.tx_sdu_bytes
                        << " tx_lat=" << rlc.tx_sdu_latency_us << "us"
                        << " rx_sdus=" << rlc.rx_sdus << " rx_bytes=" << rlc.rx_sdu_bytes
                        << "\n";
            }
        }
        
        // PDCP DRBs (correlate via CU-UP index)
        {
            std::lock_guard<std::mutex> lock(pdcp_mutex);
            for (const auto& [key, pdcp] : pdcp_drb) {
                uint16_t pdcp_rnti = get_rnti_from_cu_up_ue_index(key.first);
                if (pdcp_rnti != rnti) continue;
                logfile << "  PDCP DRB=" << (int)key.second << " (LCID=" << (int)(key.second + 3) << ")"
                        << " tx_pdus=" << pdcp.tx_pdus << " tx_bytes=" << pdcp.tx_pdu_bytes
                        << " tx_drop=" << pdcp.tx_dropped_sdus << " tx_discard=" << pdcp.tx_discard_timeouts
                        << " tx_lat=" << (pdcp.tx_pdu_latency_ns / 1000) << "us"
                        << " rx_pdus=" << pdcp.rx_pdus << " rx_bytes=" << pdcp.rx_pdu_bytes
                        << " rx_drop=" << pdcp.rx_dropped_pdus
                        << " rx_lat=" << (pdcp.rx_sdu_latency_ns / 1000) << "us"
                        << "\n";
            }
        }
        
        // GTP
        {
            std::lock_guard<std::mutex> lock(gtp_mutex);
            for (const auto& [cu_up_idx, gtp] : gtp_ue) {
                uint16_t gtp_rnti = get_rnti_from_cu_up_ue_index(cu_up_idx);
                if (gtp_rnti != rnti) continue;
                logfile << "  GTP dl_pkts=" << gtp.dl_pkts << " dl_bytes=" << gtp.dl_bytes
                        << " ul_pkts=" << gtp.ul_pkts << " ul_bytes=" << gtp.ul_bytes
                        << "\n";
            }
        }
    }
    
    logfile.close();
}

//==============================================================================
// Control Reception
//==============================================================================

void edgeric::get_weights_from_er() {
    ensure_initialized();
    
    zmq::message_t recv_message;
    zmq::recv_result_t size = subscriber_weights.recv(recv_message, zmq::recv_flags::dontwait);

    if (size) {
        SchedulingWeights weights_msg;
        if (weights_msg.ParseFromArray(recv_message.data(), recv_message.size())) {
            er_ran_index_weights = weights_msg.ran_index();
            er_weights_tti = weights_msg.tti_index();
            weights_recved.clear();
            eligibility_mode = weights_msg.mode() == CONTROL_MODE_ELIGIBILITY;
            dl_eligible_rntis.clear();
            ul_eligible_rntis.clear();
            if (eligibility_mode) {
                eligibility_decision_slot = weights_msg.decision_native_slot();
                scheduler_policy_epoch = weights_msg.policy_epoch();
                scheduler_algorithm = weights_msg.algorithm();
                for (uint32_t value : weights_msg.dl_eligible_rntis()) {
                    if (value <= UINT16_MAX) dl_eligible_rntis.insert(static_cast<uint16_t>(value));
                }
                for (uint32_t value : weights_msg.ul_eligible_rntis()) {
                    if (value <= UINT16_MAX) ul_eligible_rntis.insert(static_cast<uint16_t>(value));
                }
            }
            
            for (int i = 0; i < weights_msg.ue_weights_size(); ++i) {
                const auto& ue_weight = weights_msg.ue_weights(i);
                uint16_t rnti = static_cast<uint16_t>(ue_weight.rnti());
                weights_recved[rnti] = ue_weight.weight();
            }
        }
    }
}

void edgeric::get_mcs_from_er() {
    ensure_initialized();
    
    zmq::message_t recv_message;
    zmq::recv_result_t size = subscriber_mcs.recv(recv_message, zmq::recv_flags::dontwait);

    if (size) {
        McsControl mcs_msg;
        if (mcs_msg.ParseFromArray(recv_message.data(), recv_message.size())) {
            er_ran_index_mcs = mcs_msg.ran_index();
            er_mcs_tti = mcs_msg.tti_index();
            mcs_recved.clear();
            
            // Parse per-UE MCS values (indexed by RNTI)
            // MCS value of 255 means "no override" (use link adaptation)
            for (const auto& ue_mcs : mcs_msg.ue_mcs()) {
                uint16_t rnti = static_cast<uint16_t>(ue_mcs.rnti());
                uint8_t mcs_val = static_cast<uint8_t>(ue_mcs.mcs());
                if (mcs_val < 255) {  // Only override if MCS < 255
                    mcs_recved[rnti] = mcs_val;
                }
            }
        }
    }
}

//==============================================================================
// Control Getters with Staleness Check
//==============================================================================

bool edgeric::are_weights_fresh() {
    // Use raw tti_cnt for accurate comparison (no wraparound ambiguity)
    // muApp echoes back the raw TTI from metrics, we compare with current raw TTI
    uint32_t current_tti = tti_cnt;
    uint32_t received_tti = er_weights_tti;
    
    // Simple age calculation - no wraparound since we use raw TTI
    // Handle case where received_tti > current_tti (shouldn't happen, but be safe)
    uint32_t age = (current_tti >= received_tti) ? (current_tti - received_tti) : STALENESS_THRESHOLD + 1;
    
    // Weights are fresh if age <= STALENESS_THRESHOLD (2 TTIs = 2ms)
    return (age <= STALENESS_THRESHOLD);
}

uint32_t edgeric::get_weights_tti() {
    return er_weights_tti;
}

std::optional<float> edgeric::get_weights(uint16_t rnti) {
    if (eligibility_mode) {
        return std::nullopt;
    }
    // Only return weights if they are fresh (not stale)
    if (!are_weights_fresh()) {
        return std::nullopt;
    }
    
    auto it = weights_recved.find(rnti);
    return (it != weights_recved.end()) ? std::optional<float>(it->second) : std::nullopt;
}

bool edgeric::eligibility_control_active() {
    if (not eligibility_mode or not native_slot_initialized) return false;
    return native_slot >= eligibility_decision_slot and
           native_slot - eligibility_decision_slot <= ELIGIBILITY_STALENESS_SLOTS;
}

std::optional<bool> edgeric::is_dl_eligible(uint16_t rnti) {
    if (not eligibility_control_active()) return std::nullopt;
    return dl_eligible_rntis.count(rnti) != 0;
}

std::optional<bool> edgeric::is_ul_eligible(uint16_t rnti) {
    if (not eligibility_control_active()) return std::nullopt;
    return ul_eligible_rntis.count(rnti) != 0;
}

std::optional<float> edgeric::get_weights_unchecked(uint16_t rnti) {
    auto it = weights_recved.find(rnti);
    return (it != weights_recved.end()) ? std::optional<float>(it->second) : std::nullopt;
}

bool edgeric::are_mcs_fresh() {
    // Use raw tti_cnt for accurate comparison (no wraparound ambiguity)
    uint32_t current_tti = tti_cnt;
    uint32_t received_tti = er_mcs_tti;
    
    // Simple age calculation - handle case where received_tti > current_tti
    uint32_t age = (current_tti >= received_tti) ? (current_tti - received_tti) : STALENESS_THRESHOLD + 1;
    
    // MCS is fresh if age <= STALENESS_THRESHOLD (2 TTIs = 2ms)
    return (age <= STALENESS_THRESHOLD);
}

std::optional<uint8_t> edgeric::get_mcs(uint16_t rnti) {
    // Only return MCS override if it is fresh (not stale)
    if (!are_mcs_fresh()) {
        return std::nullopt;
    }
    
    auto it = mcs_recved.find(rnti);
    return (it != mcs_recved.end()) ? std::optional<uint8_t>(it->second) : std::nullopt;
}

//==============================================================================
// Legacy Helper Functions
//==============================================================================

std::vector<uint8_t> edgeric::get_drb_lcids(uint16_t rnti) {
    std::set<uint8_t> lcids;
    for (const auto& [key, _] : mac_drb) {
        if (key.first == rnti) lcids.insert(key.second);
    }
    return std::vector<uint8_t>(lcids.begin(), lcids.end());
}

std::vector<uint8_t> edgeric::get_pdcp_drb_ids(uint16_t rnti) {
    // Deprecated - use get_pdcp_drb_ids_by_ue_index
    return {};
}

std::vector<uint8_t> edgeric::get_pdcp_drb_ids_by_ue_index(uint32_t ue_index) {
    std::lock_guard<std::mutex> lock(pdcp_mutex);
    std::set<uint8_t> drb_ids;
    for (const auto& [key, _] : pdcp_drb) {
        if (key.first == ue_index) drb_ids.insert(key.second);
    }
    return std::vector<uint8_t>(drb_ids.begin(), drb_ids.end());
}

std::optional<gtp_ue_metrics> edgeric::get_gtp_metrics(uint16_t rnti) {
    std::lock_guard<std::mutex> lock(gtp_mutex);
    for (const auto& [cu_up_idx, gtp] : gtp_ue) {
        if (get_rnti_from_cu_up_ue_index(cu_up_idx) == rnti) {
            return gtp;
        }
    }
    return std::nullopt;
}

void edgeric::collect_ue_telemetry(uint16_t rnti, float cqi, float snr,
                                   uint32_t dl_buffer_bytes, uint32_t ul_buffer_bytes) {
    // Only update CQI, SNR, and buffer values - DO NOT overwrite TBS/PRBs/MCS
    // which are set earlier during the scheduling phase
    auto& m = mac_ue[rnti];
    m.cqi = static_cast<uint32_t>(cqi);
    m.snr = snr;
    m.dl_buffer = dl_buffer_bytes;
    m.ul_buffer = ul_buffer_bytes;
}
