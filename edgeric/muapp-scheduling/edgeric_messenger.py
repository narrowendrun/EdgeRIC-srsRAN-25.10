#!/usr/bin/env python3
"""
EdgeRIC Messenger - ZMQ-based metrics collector and weight sender

This module provides the interface between muApps and the RAN:
- get_metrics_multi(): Receives per-TTI metrics from RAN
- send_scheduling_weight(): Sends scheduling weights with TTI for staleness check

The RAN only applies weights if: current_TTI - received_TTI <= 1
"""

import zmq
import sys
import os
import time
from typing import Dict, Optional, List, Tuple

# Add parent directory for protobuf imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Import generated protobufs
try:
    import control_weights_pb2
    import metrics_pb2
except ImportError:
    print("Error: Could not import protobufs. Generate them first:")
    print("  cd ../lib/protobufs && protoc --python_out=../../edgeric *.proto")
    sys.exit(1)


class EdgeRICMessenger:
    """
    Singleton class for EdgeRIC ZMQ communication.
    
    Handles:
    - Subscribing to per-TTI metrics from RAN
    - Publishing scheduling weights back to RAN with TTI
    """
    _instance = None
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance
    
    def __init__(self,
                 weights_ipc: str = "ipc:///tmp/control_weights",
                 metrics_ipc: str = "ipc:///tmp/metrics_data"):
        if self._initialized:
            return
            
        self.context = zmq.Context()
        
        # Publisher for scheduling weights
        self.weights_socket = self.context.socket(zmq.PUB)
        self.weights_socket.setsockopt(zmq.SNDHWM, 1)      # Minimal send queue
        self.weights_socket.setsockopt(zmq.CONFLATE, 1)    # Only keep latest message
        self.weights_socket.bind(weights_ipc)
        
        # Subscriber for metrics
        self.metrics_socket = self.context.socket(zmq.SUB)
        self.metrics_socket.setsockopt(zmq.CONFLATE, 1)  # Only keep latest
        self.metrics_socket.setsockopt_string(zmq.SUBSCRIBE, "")
        self.metrics_socket.connect(metrics_ipc)
        
        # State
        self.ran_index = 0
        self.current_tti = 0
        self.current_native_slot = 0
        self.last_metrics: Dict[int, dict] = {}
        
        # Give time for ZMQ connections
        time.sleep(0.1)
        
        self._initialized = True
        print(f"[EdgeRIC] Messenger initialized")
        print(f"[EdgeRIC] Weights: {weights_ipc}")
        print(f"[EdgeRIC] Metrics: {metrics_ipc}")
    
    def get_metrics(self, timeout_ms: int = 100) -> Optional[Dict[int, dict]]:
        """
        Get latest metrics from RAN.
        
        Returns:
            Dictionary mapping RNTI -> metrics dict, or None if no data
            
        Metrics dict contains (same structure as collector.py):
            Channel quality:
            - CQI: Channel Quality Indicator (0-15)
            - SNR: Signal-to-Noise Ratio in dB
            
            Buffers:
            - Backlog / dl_buffer: DL buffer pending bytes
            - UL_buffer / ul_buffer: UL buffer pending bytes
            
            Scheduling this TTI:
            - Tx_brate / dl_tbs: DL bytes scheduled
            - ul_tbs: UL bytes scheduled
            - dl_prbs / ul_prbs: PRBs allocated
            - dl_mcs / ul_mcs: MCS index
            
            Goodput:
            - dl_acked_bytes: DL bytes successfully ACK'd
            - ul_ok_bytes: UL bytes successfully decoded
            
            HARQ feedback this TTI:
            - dl_harq_ack / dl_harq_nack
            - ul_crc_ok / ul_crc_fail
            
            MAC delays (ms):
            - avg_ce_delay_ms, avg_crc_delay_ms, avg_sum_mac_delay_ms
        """
        try:
            if self.metrics_socket.poll(timeout=timeout_ms):
                data = self.metrics_socket.recv(flags=zmq.NOBLOCK)
                tti_msg = metrics_pb2.TtiMetrics()
                tti_msg.ParseFromString(data)
                
                self.current_tti = tti_msg.tti_index
                self.current_native_slot = tti_msg.native_slot
                
                # Log received metrics every 500 TTIs
                if (self.current_tti % 500) == 0:
                    rntis = [ue.rnti for ue in tti_msg.ues]
                    lcids_per_ue = {}
                    for ue in tti_msg.ues:
                        # Only show data bearers (LCID >= 4), matching collector.py
                        lcids = set()
                        for rlc in ue.rlc_drb:
                            if rlc.lcid >= 4:
                                lcids.add(rlc.lcid)
                        lcids_per_ue[ue.rnti] = sorted(lcids) if lcids else []
                    
                    print(f"[muApp RX] TTI={self.current_tti} UEs={len(rntis)} "
                          f"RNTIs={rntis} DRBs={lcids_per_ue}")
                
                # Build UE metrics dictionary (matches collector.py structure)
                ue_data = {}
                for ue in tti_msg.ues:
                    mac = ue.mac
                    ue_data[ue.rnti] = {
                        # Channel quality
                        'CQI': mac.cqi,
                        'SNR': mac.snr,
                        
                        # Buffers (Backlog = DL buffer for backwards compatibility)
                        'Backlog': mac.dl_buffer,
                        'dl_buffer': mac.dl_buffer,
                        'UL_buffer': mac.ul_buffer,
                        'ul_buffer': mac.ul_buffer,
                        
                        # Scheduling this TTI
                        'Tx_brate': mac.dl_tbs,      # DL bytes scheduled
                        'dl_tbs': mac.dl_tbs,
                        'ul_tbs': mac.ul_tbs,
                        'dl_prbs': mac.dl_prbs,
                        'ul_prbs': mac.ul_prbs,
                        'dl_mcs': mac.dl_mcs,
                        'ul_mcs': mac.ul_mcs,
                        
                        # Goodput (actual ACK'd bytes)
                        'dl_acked_bytes': mac.dl_acked_bytes,
                        'ul_ok_bytes': mac.ul_ok_bytes,
                        
                        # HARQ feedback this TTI
                        'dl_harq_ack': mac.dl_harq_ack,
                        'dl_harq_nack': mac.dl_harq_nack,
                        'ul_crc_ok': mac.ul_crc_ok,
                        'ul_crc_fail': mac.ul_crc_fail,
                        
                        # MAC delays (ms)
                        'avg_ce_delay_ms': mac.avg_ce_delay_ms,
                        'avg_crc_delay_ms': mac.avg_crc_delay_ms,
                        'avg_sum_mac_delay_ms': mac.avg_sum_mac_delay_ms,
                    }
                
                self.last_metrics = ue_data
                return ue_data
                
        except zmq.Again:
            pass
        except Exception as e:
            print(f"[EdgeRIC] Metrics error: {e}")
        
        return self.last_metrics if self.last_metrics else None
    
    def get_tti(self) -> int:
        """Get the current TTI index from last received metrics."""
        return self.current_tti
    
    def send_weights(self, weights: List[Tuple[int, float]], include_tti: bool = True, tti_offset: int = 0):
        """
        Send scheduling weights to RAN.
        
        Args:
            weights: List of (RNTI, weight) tuples
            include_tti: If True, include current TTI for staleness check
            tti_offset: Offset to apply to TTI (for testing staleness, e.g., -1 to simulate old message)
        """
        msg = control_weights_pb2.SchedulingWeights()
        msg.ran_index = self.ran_index
        self.ran_index += 1
        
        if include_tti:
            msg.tti_index = self.current_tti + tti_offset
        
        for rnti, weight in weights:
            ue_weight = msg.ue_weights.add()
            ue_weight.rnti = int(rnti)
            ue_weight.weight = float(weight)
        
        serialized = msg.SerializeToString()
        self.weights_socket.send(serialized)
    
    def send_weights_array(self, weights_array, include_tti: bool = True, verbose: bool = False, tti_offset: int = 0):
        """
        Send scheduling weights from flat array format [RNTI1, w1, RNTI2, w2, ...].
        
        Args:
            weights_array: Numpy array or list with alternating RNTI and weight values
            include_tti: If True, include current TTI for staleness check
            verbose: If True, print the message being sent
            tti_offset: Offset to apply to TTI (for testing staleness, e.g., -1 to simulate old message)
        """
        weights = []
        for i in range(0, len(weights_array), 2):
            rnti = int(weights_array[i])
            weight = float(weights_array[i + 1])
            weights.append((rnti, weight))
        
        # Log every 500 TTIs (ignore verbose flag for frequency control)
        if (self.current_tti % 500) == 0:
            print(f"[muApp TX] TTI={self.current_tti + tti_offset} weights: {[(r, f'{w:.2f}') for r, w in weights]}")
        
        self.send_weights(weights, include_tti, tti_offset)

    def send_eligibility(self, dl_rntis, ul_rntis, algorithm: str, policy_epoch: int):
        """Admit candidates only; native srsRAN still owns grants and PRB sizing."""
        msg = control_weights_pb2.SchedulingWeights(
            ran_index=self.ran_index,
            tti_index=self.current_tti,
            mode=control_weights_pb2.CONTROL_MODE_ELIGIBILITY,
            policy_epoch=policy_epoch,
            algorithm=algorithm,
            decision_native_slot=self.current_native_slot,
            dl_eligible_rntis=sorted(int(value) for value in dl_rntis),
            ul_eligible_rntis=sorted(int(value) for value in ul_rntis),
        )
        self.ran_index += 1
        self.weights_socket.send(msg.SerializeToString())
    
    def close(self):
        """Clean up ZMQ resources."""
        self.weights_socket.close()
        self.metrics_socket.close()
        self.context.term()


# Global messenger instance
_messenger: Optional[EdgeRICMessenger] = None


def _get_messenger() -> EdgeRICMessenger:
    """Get or create the global messenger instance."""
    global _messenger
    if _messenger is None:
        _messenger = EdgeRICMessenger()
    return _messenger


# ============================================================================
# Public API - Compatible with original edgeric_messenger interface
# ============================================================================

def get_metrics_multi() -> Dict[int, dict]:
    """
    Get metrics for all UEs from RAN.
    
    Returns:
        Dictionary mapping RNTI -> metrics dict
        
    Example:
        ue_data = get_metrics_multi()
        for rnti, metrics in ue_data.items():
            print(f"UE {rnti}: CQI={metrics['CQI']}, Backlog={metrics['Backlog']}")
    """
    messenger = _get_messenger()
    metrics = messenger.get_metrics()
    return metrics if metrics else {}


def get_tti_index() -> int:
    """
    Get the current TTI index from last received metrics.
    
    Returns:
        TTI index (0-9999, rolls over)
    """
    messenger = _get_messenger()
    return messenger.get_tti()


def send_scheduling_weight(weights, include_tti: bool = True, verbose: bool = False, tti_offset: int = 0):
    """
    Send scheduling weights to RAN.
    
    Args:
        weights: Numpy array or list with format [RNTI1, weight1, RNTI2, weight2, ...]
                 where weight_i means UE_i gets weight_i * n_prb for that TTI
        include_tti: If True, include current TTI for staleness check
                     (RAN discards if current_TTI - received_TTI > 1)
        verbose: If True, print every message sent
        tti_offset: Offset to apply to TTI (for testing staleness, e.g., -3 to simulate stale message)
    
    Example:
        weights = np.array([17921, 0.3, 17922, 0.7])  # UE1 gets 30%, UE2 gets 70%
        send_scheduling_weight(weights, True)
        send_scheduling_weight(weights, True, tti_offset=-3)  # Test staleness (should be rejected)
    """
    messenger = _get_messenger()
    messenger.send_weights_array(weights, include_tti, verbose, tti_offset)


def send_scheduling_eligibility(dl_rntis, ul_rntis, algorithm: str, policy_epoch: int):
    _get_messenger().send_eligibility(dl_rntis, ul_rntis, algorithm, policy_epoch)


def cleanup():
    """Clean up ZMQ resources."""
    global _messenger
    if _messenger:
        _messenger.close()
        _messenger = None
