import unittest

from vwd_scheduler import ResolvedAttempt, VwdScheduler, VwdTarget


def outcome(sequence, rnti, slot, result, attempt=0, direction="dl"):
    return ResolvedAttempt(sequence, direction, rnti, slot - 4, slot, attempt, result)


class VwdSchedulerTest(unittest.TestCase):
    def make_scheduler(self):
        return VwdScheduler(
            direction="dl",
            targets={1: VwdTarget(0.5, 0.25), 2: VwdTarget(0.25, 0.25)},
            max_selected=1,
            probability_window=3,
            epoch_slot=10,
        )

    def test_probability_uses_resolved_initial_attempts_only(self):
        scheduler = self.make_scheduler()
        scheduler.observe_slot(10, [
            outcome(1, 1, 10, "ack"),
            outcome(2, 1, 10, "nack"),
            outcome(3, 1, 10, "ack", attempt=1),
            outcome(4, 1, 10, "crc_ok", direction="ul"),
        ])
        self.assertEqual(scheduler.success_probability(1), 0.5)
        self.assertIsNone(scheduler.success_probability(2))

    def test_native_ack_on_timeout_is_success(self):
        scheduler = self.make_scheduler()
        scheduler.observe_slot(10, [outcome(1, 1, 10, "ack_on_timeout")])
        self.assertEqual(scheduler.success_probability(1), 1.0)
        self.assertEqual(scheduler.snapshot(10)[1]["age_slots"], 1)

    def test_probability_window_and_duplicate_sequence(self):
        scheduler = self.make_scheduler()
        events = [outcome(i, 1, 10 + i, value) for i, value in enumerate(
            ["nack", "ack", "ack", "nack"], start=1
        )]
        for event in events:
            scheduler.observe_slot(event.feedback_slot, [event, event])
        self.assertAlmostEqual(scheduler.success_probability(1), 2 / 3)
        self.assertEqual(scheduler.snapshot(events[-1].feedback_slot)[1]["resolved_initial_attempts"], 3)

    def test_event_sequence_gap_fails_closed(self):
        scheduler = self.make_scheduler()
        scheduler.observe_slot(10, [outcome(1, 1, 10, "ack")])
        with self.assertRaisesRegex(ValueError, "sequence gap"):
            scheduler.observe_slot(11, [outcome(3, 1, 11, "nack")])

    def test_causal_age_resets_when_success_feedback_arrives(self):
        scheduler = self.make_scheduler()
        scheduler.observe_slot(10)
        scheduler.observe_slot(13)
        self.assertEqual(scheduler.snapshot(13)[1]["age_slots"], 4)
        scheduler.observe_slot(14, [outcome(1, 1, 14, "ack")])
        self.assertEqual(scheduler.snapshot(14)[1]["age_slots"], 1)
        scheduler.observe_slot(16, [outcome(2, 1, 16, "nack")])
        self.assertEqual(scheduler.snapshot(16)[1]["age_slots"], 3)

    def test_deficit_ranking_uses_targets_and_success_history(self):
        scheduler = self.make_scheduler()
        scheduler.observe_slot(10, [ResolvedAttempt(1, "dl", 1, 10, 10, 0, "ack")])
        self.assertEqual(scheduler.select(11, [1, 2]), [2])

    def test_target_change_starts_new_epoch_and_preserves_aoi_history(self):
        scheduler = self.make_scheduler()
        scheduler.observe_slot(10, [outcome(1, 1, 10, "ack")])
        scheduler.start_target_epoch(20, {1: VwdTarget(0.2, 0.1)})
        snap = scheduler.snapshot(20)[1]
        self.assertEqual(snap["successes_in_epoch"], 0)
        self.assertEqual(snap["age_slots"], 1)
        self.assertEqual(snap["success_probability"], 1.0)

    def test_late_pre_epoch_feedback_does_not_reduce_new_deficit(self):
        scheduler = self.make_scheduler()
        scheduler.observe_slot(10)
        scheduler.start_target_epoch(20, {1: VwdTarget(0.2, 0.1)})
        scheduler.observe_slot(22, [ResolvedAttempt(1, "dl", 1, 19, 22, 0, "ack")])
        snap = scheduler.snapshot(22)[1]
        self.assertEqual(snap["successes_in_epoch"], 0)
        self.assertEqual(snap["success_probability"], 1.0)
        self.assertEqual(snap["age_slots"], 1)


if __name__ == "__main__":
    unittest.main()
