import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from edgeric import metrics_pb2
from edgeric.harq_analysis import (
    SlotObservation,
    derive_aoi,
    load_harq_events,
    load_ue_slots,
    success_probability,
)
from edgeric.metrics_recorder import (
    INSERT_UE_MAC,
    UE_MAC_COLUMNS,
    harq_event_row,
    insert_harq_events,
    open_database,
    ue_mac_row,
)


def event(
    sequence_id: int,
    tx_slot: int,
    outcome: str,
    *,
    attempt_number: int = 0,
    direction: str = "HARQ_DIRECTION_DL",
):
    return SimpleNamespace(
        sequence_id=sequence_id,
        cell_index=0,
        du_ue_index=7,
        rnti=0x4601,
        direction=direction,
        tx_slot=tx_slot,
        feedback_slot=tx_slot + 4,
        harq_id=sequence_id % 16,
        attempt_number=attempt_number,
        is_retransmission=attempt_number > 0,
        ndi=attempt_number == 0,
        outcome=f"HARQ_OUTCOME_{outcome}",
        tbs_bytes=1200,
    )


class HarqArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        path = Path(self.temporary_directory.name) / "metrics.sqlite3"
        self.database, _ = open_database(path)

    def tearDown(self):
        self.database.close()
        self.temporary_directory.cleanup()

    def test_schema_v4_has_native_slots_harq_identity_and_scheduler_provenance(self):
        version = self.database.execute(
            "SELECT value FROM metadata WHERE key = 'schema_version'"
        ).fetchone()[0]
        self.assertEqual(version, "4")
        harq_columns = {
            row[1] for row in self.database.execute("PRAGMA table_info(harq_outcome)")
        }
        self.assertTrue(
            {"sequence_id", "cell_index", "du_ue_index", "tx_slot", "outcome"}
            <= harq_columns
        )
        ue_mac_columns = {row[1] for row in self.database.execute("PRAGMA table_info(ue_mac)")}
        self.assertIn("native_slot", ue_mac_columns)
        slot_columns = {row[1] for row in self.database.execute("PRAGMA table_info(slot_observation)")}
        self.assertTrue({"scheduler_policy_epoch", "scheduler_algorithm", "scheduler_control_active",
                         "dl_eligible_rntis", "ul_eligible_rntis"} <= slot_columns)
        self.assertTrue(
            {
                "ce_delay_valid", "crc_delay_valid", "pucch_harq_delay_valid",
                "pusch_harq_delay_valid", "sr_to_pusch_delay_valid",
            }
            <= ue_mac_columns
        )

    def test_schema_v2_database_is_upgraded_without_inventing_historical_slots(self):
        legacy_path = Path(self.temporary_directory.name) / "legacy.sqlite3"
        legacy = sqlite3.connect(legacy_path)
        legacy.execute(
            "CREATE TABLE ue_mac ("
            "id INTEGER PRIMARY KEY, raw_tti_id INTEGER NOT NULL, timestamp_us INTEGER NOT NULL, "
            "tti_index INTEGER NOT NULL, rnti INTEGER NOT NULL)"
        )
        legacy.execute(
            "INSERT INTO ue_mac(raw_tti_id, timestamp_us, tti_index, rnti) VALUES (1, 2, 3, 4)"
        )
        legacy.commit()
        legacy.close()

        upgraded, legacy_raw_id = open_database(legacy_path)
        try:
            self.assertTrue(legacy_raw_id)
            row = upgraded.execute(
                "SELECT native_slot FROM ue_mac WHERE rnti = 4"
            ).fetchone()
            self.assertIsNone(row[0])
            validity = upgraded.execute(
                "SELECT ce_delay_valid, crc_delay_valid, pucch_harq_delay_valid, "
                "pusch_harq_delay_valid, sr_to_pusch_delay_valid FROM ue_mac WHERE rnti = 4"
            ).fetchone()
            self.assertEqual(validity, (0, 0, 0, 0, 0))
            self.assertEqual(
                upgraded.execute(
                    "SELECT value FROM metadata WHERE key = 'schema_version'"
                ).fetchone()[0],
                "4",
            )
        finally:
            upgraded.close()

    def test_optional_delay_projection_distinguishes_absent_from_true_zero(self):
        ue = metrics_pb2.UeMetrics(rnti=0x4601)
        ue.mac.avg_ce_delay_ms = 0.0
        ue.mac.avg_crc_delay_ms = 4.002

        row = ue_mac_row(None, 1, 2, 3, ue)
        self.assertEqual(len(row), len(UE_MAC_COLUMNS))
        self.database.execute(INSERT_UE_MAC, row)
        projected = dict(zip(UE_MAC_COLUMNS, row))
        self.assertEqual(projected["ce_delay_us"], 0)
        self.assertEqual(projected["ce_delay_valid"], 1)
        self.assertEqual(projected["crc_delay_us"], 4002)
        self.assertEqual(projected["crc_delay_valid"], 1)
        self.assertEqual(projected["pucch_harq_delay_us"], 0)
        self.assertEqual(projected["pucch_harq_delay_valid"], 0)
        self.assertEqual(projected["sum_mac_delay_us"], 0)

    def test_event_insert_is_idempotent_and_rejects_inconsistent_attempt(self):
        valid = event(1, 10, "ACK")
        inconsistent = event(2, 11, "NACK", attempt_number=1)
        inconsistent.is_retransmission = False

        self.assertEqual(insert_harq_events(self.database, 123, [valid]), (1, 0))
        self.assertEqual(insert_harq_events(self.database, 124, [valid]), (0, 0))
        self.assertEqual(insert_harq_events(self.database, 125, [inconsistent]), (0, 1))
        self.assertEqual(
            self.database.execute("SELECT COUNT(*) FROM harq_outcome").fetchone()[0], 1
        )

    def test_generated_ack_on_timeout_keeps_success_provenance(self):
        protobuf_event = metrics_pb2.HarqEvent(
            sequence_id=8,
            cell_index=0,
            du_ue_index=7,
            rnti=0x4601,
            direction=metrics_pb2.HARQ_DIRECTION_DL,
            tx_slot=20,
            feedback_slot=24,
            harq_id=3,
            ndi=True,
            outcome=metrics_pb2.HARQ_OUTCOME_ACK_ON_TIMEOUT,
            tbs_bytes=900,
        )
        row = harq_event_row(123, protobuf_event)
        self.assertEqual(row[5], "dl")
        self.assertEqual(row[12], "ack_on_timeout")

    def test_load_filter_probability_and_aoi(self):
        raw_events = [
            event(1, 10, "ACK"),
            event(2, 12, "NACK"),
            event(3, 13, "ACK", attempt_number=1),
            event(4, 14, "DTX_TIMEOUT"),
            event(5, 15, "ACK_ON_TIMEOUT"),
        ]
        self.assertEqual(insert_harq_events(self.database, 123, raw_events), (5, 0))
        for native_slot in range(10, 16):
            self.database.execute(
                "INSERT INTO slot_observation("
                "native_slot, message_sequence_id, timestamp_us, tti_index, numerology, slot_duration_ns"
                ") VALUES (?, ?, ?, ?, ?, ?)",
                (native_slot, native_slot, native_slot * 500, native_slot % 10_000, 1, 500_000),
            )
            self.database.execute(
                "INSERT INTO ue_slot_observation VALUES (?, ?)",
                (native_slot, 0x4601),
            )

        events = load_harq_events(
            self.database, cell_index=0, du_ue_index=7, direction="dl"
        )
        probability = success_probability(events)
        self.assertEqual(
            (probability.successes, probability.failures, probability.total_transmissions),
            (2, 2, 4),
        )
        self.assertAlmostEqual(probability.probability, 0.5)

        slots = load_ue_slots(self.database, 0x4601)
        trace = derive_aoi(events, slots)
        self.assertEqual([point.age_slots for point in trace], [1, 2, 3, 4, 5, 1])
        self.assertEqual(
            [point.age_ns for point in trace],
            [500_000, 1_000_000, 1_500_000, 2_000_000, 2_500_000, 500_000],
        )
        self.assertEqual(
            [point.attempted for point in trace], [True, False, True, False, True, True]
        )
        self.assertEqual(
            [point.success for point in trace], [True, False, False, False, False, True]
        )

    def test_no_transmissions_has_undefined_probability(self):
        result = success_probability([])
        self.assertEqual(result.total_transmissions, 0)
        self.assertIsNone(result.probability)

    def test_aoi_requires_strictly_ordered_observations(self):
        slots = [
            SlotObservation(2, 0, 1, 500_000),
            SlotObservation(2, 500, 1, 500_000),
        ]
        with self.assertRaises(ValueError):
            derive_aoi([], slots)


if __name__ == "__main__":
    unittest.main()
