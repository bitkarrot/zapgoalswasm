//! Portable host-free tests of the actual production projection module.
#[path = "../../wasm/src/accounting.rs"]
pub mod accounting;

#[cfg(test)]
mod tests {
    use super::accounting::{
        calendar_boundary, normalize_date, parse_timestamp, project, Projection, MAX_PERIODS,
    };
    use serde_json::{json, Value};

    fn ts(date: &str) -> u64 {
        parse_timestamp(&json!(date)).unwrap()
    }

    fn goal() -> Value {
        json!({
            "id": "goal", "title": "Original presentation", "goalAmount": 100,
            "currentAmount": 0, "createdAt": "2024-01-01T00:00:00Z",
            "targetDate": "2024-01-31T00:00:00Z",
            "recurring": true, "recurrenceUnit": "month", "recurrenceInterval": 1,
            "recurrenceDayOfMonth": 0, "periodIndex": 0,
            "periodStartDate": "2024-01-01T00:00:00Z",
            "periodEndDate": "2024-01-31T00:00:00Z",
            "rolloverMode": "counts_as_progress", "sweepMode": "target_amount"
        })
    }

    fn receipt(id: &str, amount: u64, issued: &str) -> Value {
        json!({"id": id, "goalId": "goal", "amount": amount, "issuedAt": ts(issued), "verified": true})
    }

    fn assert_conserved(result: &Projection) {
        let totals = &result.totals;
        let n = |field: &str| totals[field].as_u64().unwrap();
        assert_eq!(n("openingAmount") + n("receiptAmount"), n("totalAmount"));
        assert_eq!(
            n("movedAmount") + n("retainedAmount") + n("currentAmount"),
            n("totalAmount")
        );
        assert_eq!(result.goal["currentAmount"], totals["currentAmount"]);
        for row in &result.history {
            let n = |field: &str| row[field].as_u64().unwrap();
            assert_eq!(n("openingAmount") + n("receivedAmount"), n("zappedAmount"));
            assert_eq!(
                n("movedAmount") + n("rolloverAmount") + n("retainedAmount"),
                n("zappedAmount")
            );
        }
    }

    #[test]
    fn nonrecurring_preserves_opening_and_ignores_legacy_receipts() {
        let mut input = goal();
        input["recurring"] = json!(false);
        input["currentAmount"] = json!(70);
        let receipts = vec![
            receipt("new", 30, "2024-01-02T00:00:00Z"),
            json!({"id": "legacy", "goalId": "goal", "amount": 500, "newTotal": 999, "verified": false}),
            json!({"id": "old-schema", "amount": 900, "newTotal": 900}),
        ];
        let original = input.clone();
        let original_receipts = receipts.clone();
        let result = project(&input, &receipts, ts("2024-02-01T00:00:00Z")).unwrap();
        assert_eq!(result.goal["currentAmount"], 100);
        assert_eq!(result.totals["verifiedReceiptCount"], 1);
        assert_eq!(result.totals["receiptAmount"], 30);
        assert!(result.history.is_empty());
        assert_eq!(input, original);
        assert_eq!(receipts, original_receipts);
        assert_conserved(&result);
    }

    #[test]
    fn empty_nonrecurring_goal_needs_no_calendar() {
        let result = project(&json!({"id": "goal"}), &[], 0).unwrap();
        assert_eq!(result.goal["currentAmount"], 0);
        assert_conserved(&result);
    }

    #[test]
    fn active_period_does_not_allocate_a_met_target_early() {
        let receipts = vec![receipt("a", 250, "2024-01-02T00:00:00Z")];
        let result = project(&goal(), &receipts, ts("2024-01-30T00:00:00Z")).unwrap();
        assert_eq!(result.goal["currentAmount"], 250);
        assert_eq!(result.totals["movedAmount"], 0);
        assert!(result.history.is_empty());
        assert_conserved(&result);
    }

    #[test]
    fn closed_period_carries_excess() {
        let receipts = vec![receipt("a", 250, "2024-01-02T00:00:00Z")];
        let result = project(&goal(), &receipts, ts("2024-01-31T00:00:00Z")).unwrap();
        assert_eq!(result.goal["currentAmount"], 150);
        assert_eq!(result.goal["periodIndex"], 1);
        assert_eq!(result.goal["periodEndDate"], "2024-02-29T00:00:00Z");
        assert_eq!(result.history[0]["movedAmount"], 100);
        assert_eq!(result.history[0]["rolloverAmount"], 150);
        assert_eq!(result.history[0]["retainedAmount"], 0);
        assert_conserved(&result);
    }

    #[test]
    fn reset_excess_is_retained_not_erased() {
        let mut input = goal();
        input["rolloverMode"] = json!("reset_to_zero");
        let receipts = vec![receipt("a", 250, "2024-01-02T00:00:00Z")];
        let result = project(&input, &receipts, ts("2024-01-31T00:00:00Z")).unwrap();
        assert_eq!(result.goal["currentAmount"], 0);
        assert_eq!(result.history[0]["movedAmount"], 100);
        assert_eq!(result.history[0]["rolloverAmount"], 0);
        assert_eq!(result.history[0]["retainedAmount"], 150);
        assert_eq!(result.totals["retainedAmount"], 150);
        assert_conserved(&result);
    }

    #[test]
    fn entire_amount_allocates_once_for_either_rollover_mode() {
        for rollover in ["counts_as_progress", "reset_to_zero"] {
            let mut input = goal();
            input["sweepMode"] = json!("entire_amount");
            input["rolloverMode"] = json!(rollover);
            let receipts = vec![receipt("a", 250, "2024-01-02T00:00:00Z")];
            let result = project(&input, &receipts, ts("2024-04-01T00:00:00Z")).unwrap();
            assert_eq!(result.goal["currentAmount"], 0);
            assert_eq!(result.totals["movedAmount"], 250);
            assert_eq!(result.totals["retainedAmount"], 0);
            assert_conserved(&result);
        }
    }

    #[test]
    fn exact_boundary_issuance_belongs_to_following_period() {
        let receipts = vec![
            receipt("before", 20, "2024-01-30T23:59:59Z"),
            receipt("at", 30, "2024-01-31T00:00:00Z"),
        ];
        let result = project(&goal(), &receipts, ts("2024-01-31T00:00:00Z")).unwrap();
        assert_eq!(result.history[0]["receivedAmount"], 20);
        assert_eq!(result.goal["currentAmount"], 30);
        assert_conserved(&result);
    }

    #[test]
    fn old_issuance_before_legacy_start_is_not_dropped() {
        let receipts = vec![receipt("old-issuance", 40, "2023-11-01T00:00:00Z")];
        let result = project(&goal(), &receipts, ts("2024-01-31T00:00:00Z")).unwrap();
        assert_eq!(result.history[0]["receivedAmount"], 40);
        assert_eq!(result.totals["movedAmount"], 40);
        assert_conserved(&result);
    }

    #[test]
    fn legacy_opening_belongs_to_first_represented_index_once() {
        let mut input = goal();
        input["periodIndex"] = json!(17);
        input["currentAmount"] = json!(240);
        let result = project(&input, &[], ts("2024-03-01T00:00:00Z")).unwrap();
        assert_eq!(result.goal["periodIndex"], 19);
        assert_eq!(result.history[0]["periodIndex"], 18);
        assert_eq!(result.history[1]["periodIndex"], 17);
        assert_eq!(result.history[1]["openingAmount"], 240);
        assert_eq!(result.goal["currentAmount"], 40);
        assert_eq!(result.totals["movedAmount"], 200);
        assert_eq!(input["currentAmount"], 240);
        assert_conserved(&result);
    }

    #[test]
    fn invalid_or_equal_stored_start_falls_back_to_created_at() {
        for start in ["", "broken", "2024-01-31T00:00:00Z", "2024-02-02T00:00:00Z"] {
            let mut input = goal();
            input["periodStartDate"] = json!(start);
            input["createdAt"] = json!(ts("2024-01-01T00:00:00Z").to_string());
            let result = project(&input, &[], ts("2024-01-31T00:00:00Z")).unwrap();
            assert_eq!(result.history[0]["startDate"], "2024-01-01T00:00:00Z");
        }
    }

    #[test]
    fn invalid_stored_end_falls_back_to_target_date() {
        let mut input = goal();
        input["periodEndDate"] = json!("broken");
        let result = project(&input, &[], ts("2024-01-02T00:00:00Z")).unwrap();
        assert_eq!(result.goal["periodEndDate"], "2024-01-31T00:00:00Z");
    }

    #[test]
    fn valid_stored_legacy_end_takes_priority_over_target_date() {
        let mut input = goal();
        input["targetDate"] = json!("2024-12-31T00:00:00Z");
        let result = project(&input, &[], ts("2024-02-01T00:00:00Z")).unwrap();
        assert_eq!(result.goal["periodIndex"], 1);
        assert_eq!(result.goal["targetDate"], "2024-02-29T00:00:00Z");
    }

    #[test]
    fn monthly_day_zero_remains_anchored_after_february() {
        let result = project(&goal(), &[], ts("2024-03-01T00:00:00Z")).unwrap();
        assert_eq!(result.goal["periodEndDate"], "2024-03-31T00:00:00Z");
        assert_eq!(
            calendar_boundary("2023-01-31T12:00:00Z", "month", 1, 0, 1).unwrap(),
            "2023-02-28T12:00:00Z"
        );
        assert_eq!(
            calendar_boundary("2023-01-31T12:00:00Z", "month", 1, 0, 2).unwrap(),
            "2023-03-31T12:00:00Z"
        );
    }

    #[test]
    fn explicit_month_day_clamps_to_actual_month_length() {
        assert_eq!(
            calendar_boundary("2024-02-29T00:00:00Z", "month", 1, 31, 1).unwrap(),
            "2024-03-31T00:00:00Z"
        );
        assert_eq!(
            calendar_boundary("2024-03-31T00:00:00Z", "month", 1, 31, 1).unwrap(),
            "2024-04-30T00:00:00Z"
        );
        assert_eq!(
            calendar_boundary("2024-03-31T00:00:00Z", "month", 1, 31, 2).unwrap(),
            "2024-05-31T00:00:00Z"
        );
        // The first supplied end is not retroactively changed to the configured DOM.
        assert_eq!(
            calendar_boundary("2024-02-15T00:00:00Z", "month", 1, 31, 0).unwrap(),
            "2024-02-15T00:00:00Z"
        );
    }

    #[test]
    fn quarterly_half_year_and_yearly_anchors_do_not_drift() {
        assert_eq!(
            calendar_boundary("2024-01-31T00:00:00Z", "quarter", 1, 0, 1).unwrap(),
            "2024-04-30T00:00:00Z"
        );
        assert_eq!(
            calendar_boundary("2024-01-31T00:00:00Z", "quarter", 1, 0, 2).unwrap(),
            "2024-07-31T00:00:00Z"
        );
        assert_eq!(
            calendar_boundary("2024-08-31T00:00:00Z", "half_year", 1, 0, 2).unwrap(),
            "2025-08-31T00:00:00Z"
        );
        assert_eq!(
            calendar_boundary("2024-02-29T00:00:00Z", "year", 1, 0, 1).unwrap(),
            "2025-02-28T00:00:00Z"
        );
        assert_eq!(
            calendar_boundary("2024-02-29T00:00:00Z", "year", 1, 0, 4).unwrap(),
            "2028-02-29T00:00:00Z"
        );
    }

    #[test]
    fn daily_weekly_and_multiple_intervals_are_fixed_utc() {
        assert_eq!(
            calendar_boundary("2024-03-09T12:00:00-05:00", "day", 1, 0, 2).unwrap(),
            "2024-03-11T17:00:00Z"
        );
        assert_eq!(
            calendar_boundary("2024-01-01T00:00:00Z", "week", 2, 0, 2).unwrap(),
            "2024-01-29T00:00:00Z"
        );
        assert_eq!(
            calendar_boundary("2024-01-31T00:00:00Z", "month", 2, 0, 2).unwrap(),
            "2024-05-31T00:00:00Z"
        );
    }

    #[test]
    fn late_payment_revises_issuance_period_and_carry_without_resurrection() {
        let first = vec![receipt("a", 50, "2024-01-10T00:00:00Z")];
        let as_of = ts("2024-03-01T00:00:00Z");
        let before = project(&goal(), &first, as_of).unwrap();
        assert_eq!(before.totals["movedAmount"], 50);
        let mut after_receipts = first;
        after_receipts.push(receipt("late", 180, "2024-01-20T00:00:00Z"));
        let after = project(&goal(), &after_receipts, as_of).unwrap();
        assert_eq!(after.history[1]["receivedAmount"], 230);
        assert_eq!(after.history[1]["movedAmount"], 100);
        assert_eq!(after.history[0]["receivedAmount"], 0);
        assert_eq!(after.history[0]["movedAmount"], 100);
        assert_eq!(after.goal["currentAmount"], 30);
        // Replay supplies the same immutable row set, not a historical total.
        let replay = project(&goal(), &after_receipts, as_of).unwrap();
        assert_eq!(after.goal, replay.goal);
        assert_eq!(after.history, replay.history);
        assert_eq!(after.totals, replay.totals);
        assert_conserved(&after);
    }

    #[test]
    fn concurrent_sweep_views_have_deterministic_closure_identity_and_time() {
        let receipts = vec![receipt("a", 120, "2024-01-10T00:00:00Z")];
        let one = project(&goal(), &receipts, ts("2024-02-01T00:00:00Z")).unwrap();
        let two = project(&goal(), &receipts, ts("2024-02-02T00:00:00Z")).unwrap();
        assert_eq!(one.history, two.history);
        assert_eq!(one.history[0]["id"], "goal:0");
        assert_eq!(one.history[0]["completedAt"], "2024-01-31T00:00:00Z");
    }

    #[test]
    fn presentation_changes_and_receipt_order_cannot_change_accounting() {
        let receipts = vec![
            receipt("a", 80, "2024-01-10T00:00:00Z"),
            receipt("b", 70, "2024-02-02T00:00:00Z"),
            receipt("c", 60, "2024-01-02T00:00:00Z"),
        ];
        let as_of = ts("2024-03-01T00:00:00Z");
        let original = project(&goal(), &receipts, as_of).unwrap();
        let mut edited = goal();
        edited["title"] = json!("New title from a racing presentation edit");
        edited["backgroundColor"] = json!("#123456");
        let mut reversed = receipts;
        reversed.reverse();
        let changed = project(&edited, &reversed, as_of).unwrap();
        assert_eq!(original.history, changed.history);
        assert_eq!(original.totals, changed.totals);
        assert_eq!(
            original.goal["currentAmount"],
            changed.goal["currentAmount"]
        );
    }

    #[test]
    fn timestamp_inputs_accept_number_numeric_string_and_rfc3339() {
        let timestamp = ts("2024-01-02T00:00:00Z");
        assert_eq!(parse_timestamp(&json!(timestamp)).unwrap(), timestamp);
        assert_eq!(
            parse_timestamp(&json!(timestamp.to_string())).unwrap(),
            timestamp
        );
        assert_eq!(
            parse_timestamp(&json!("2024-01-02T02:00:00+02:00")).unwrap(),
            timestamp
        );
        let mut payments = vec![];
        for (i, issued) in [
            json!(timestamp),
            json!(timestamp.to_string()),
            json!("2024-01-02T00:00:00Z"),
        ]
        .into_iter()
        .enumerate()
        {
            payments.push(json!({"id": format!("{i}"), "goalId": "goal", "amount": 10, "issuedAt": issued, "verified": true}));
        }
        let result = project(&goal(), &payments, timestamp).unwrap();
        assert_eq!(result.goal["currentAmount"], 30);
    }

    #[test]
    fn subsecond_boundaries_are_not_rounded_during_projection() {
        let mut input = goal();
        input["periodEndDate"] = json!("2024-01-31T00:00:00.5Z");
        let receipts = vec![
            json!({"goalId":"goal", "amount":20, "issuedAt":"2024-01-31T00:00:00.4Z", "verified":true}),
            json!({"goalId":"goal", "amount":30, "issuedAt":"2024-01-31T00:00:00.5Z", "verified":true}),
        ];
        let result = project(&input, &receipts, ts("2024-01-31T00:00:01Z")).unwrap();
        assert_eq!(result.history[0]["receivedAmount"], 20);
        assert_eq!(result.goal["currentAmount"], 30);
        assert!(parse_timestamp(&json!("2024-01-31T00:00:00.5Z"))
            .unwrap_err()
            .contains("whole seconds"));
        assert_eq!(
            normalize_date("2024-01-31T02:00:00.5+02:00").unwrap(),
            "2024-01-31T00:00:00.5Z"
        );
    }

    #[test]
    fn future_receipt_and_backward_clock_fail_explicitly() {
        let receipts = vec![receipt("future", 20, "2024-02-01T00:00:00Z")];
        let error = project(&goal(), &receipts, ts("2024-01-31T00:00:00Z")).unwrap_err();
        assert!(error.contains("after as_of"));
        assert!(project(&goal(), &[], ts("2023-12-31T23:59:59Z"))
            .unwrap_err()
            .contains("precedes"));
    }

    #[test]
    fn malformed_and_cross_goal_verified_receipts_fail_closed() {
        let as_of = ts("2024-02-01T00:00:00Z");
        let original = receipt("a", 20, "2024-01-10T00:00:00Z");
        for (field, value) in [
            ("goalId", json!("foreign")),
            ("goalId", Value::Null),
            ("amount", json!(0)),
            ("amount", json!(-1)),
            ("amount", json!(1.5)),
            ("amount", json!("20")),
            ("issuedAt", json!("bad")),
            ("issuedAt", json!(-1)),
            ("issuedAt", json!(u64::MAX)),
            ("issuedAt", json!("1969-12-31T23:59:59Z")),
            ("id", json!("")),
        ] {
            let mut bad = original.clone();
            bad[field] = value;
            assert!(
                project(&goal(), &[bad], as_of).is_err(),
                "accepted invalid {field}"
            );
        }
        assert!(project(&goal(), &[original.clone(), original], as_of)
            .unwrap_err()
            .contains("Duplicate"));
    }

    #[test]
    fn amount_overflow_is_never_saturated() {
        let mut input = goal();
        input["currentAmount"] = json!(u64::MAX);
        let receipts = vec![receipt("a", 1, "2024-01-10T00:00:00Z")];
        assert!(project(&input, &receipts, ts("2024-02-01T00:00:00Z"))
            .unwrap_err()
            .contains("overflow"));
        let receipts = vec![
            receipt("a", u64::MAX, "2024-01-10T00:00:00Z"),
            receipt("b", 1, "2024-01-10T00:00:00Z"),
        ];
        assert!(project(&goal(), &receipts, ts("2024-02-01T00:00:00Z"))
            .unwrap_err()
            .contains("overflow"));
    }

    #[test]
    fn period_index_overflow_fails_instead_of_wrapping() {
        let mut input = goal();
        input["periodIndex"] = json!(u64::MAX);
        assert!(project(&input, &[], ts("2024-01-31T00:00:00Z"))
            .unwrap_err()
            .contains("index overflow"));
    }

    #[test]
    fn invalid_goal_and_rule_inputs_are_errors() {
        assert!(project(&Value::Null, &[], 0).is_err());
        assert!(project(&json!({}), &[], 0).is_err());
        for (field, value) in [
            ("recurring", json!("true")),
            ("currentAmount", json!(-1)),
            ("goalAmount", json!(0)),
            ("periodIndex", json!(-1)),
            ("recurrenceUnit", json!("fortnight")),
            ("recurrenceInterval", json!(0)),
            ("recurrenceInterval", json!(366)),
            ("recurrenceDayOfMonth", json!(32)),
            ("rolloverMode", json!("unknown")),
            ("sweepMode", json!("transfer")),
        ] {
            let mut bad = goal();
            bad[field] = value;
            assert!(
                project(&bad, &[], ts("2024-02-01T00:00:00Z")).is_err(),
                "accepted invalid {field}"
            );
        }
        let mut bad = goal();
        bad["recurrenceUnit"] = json!("year");
        bad["recurrenceDayOfMonth"] = json!(31);
        assert!(project(&bad, &[], ts("2024-02-01T00:00:00Z")).is_err());
        bad = goal();
        bad["periodStartDate"] = json!("");
        bad["createdAt"] = json!("2024-02-01T00:00:00Z");
        assert!(project(&bad, &[], ts("2024-02-01T00:00:00Z"))
            .unwrap_err()
            .contains("before its end"));
        bad["targetDate"] = json!("bad");
        bad["periodEndDate"] = json!("bad");
        assert!(project(&bad, &[], ts("2024-02-01T00:00:00Z")).is_err());
    }

    #[test]
    fn calendar_overflow_and_extreme_timestamps_return_errors_without_panics() {
        assert!(calendar_boundary("2024-01-31T00:00:00Z", "day", 365, 0, u64::MAX).is_err());
        assert!(calendar_boundary("2024-01-31T00:00:00Z", "year", 365, 0, u64::MAX).is_err());
        assert!(calendar_boundary("9999-12-31T00:00:00Z", "month", 1, 0, 1).is_err());
        assert!(project(&goal(), &[], u64::MAX).is_err());
    }

    #[test]
    fn latest_hundred_history_limit_does_not_truncate_totals() {
        let mut input = goal();
        input["recurrenceUnit"] = json!("day");
        input["periodEndDate"] = json!("2024-01-02T00:00:00Z");
        input["currentAmount"] = json!(15_000);
        let as_of = ts("2024-01-02T00:00:00Z") + 149 * 86_400;
        let result = project(&input, &[], as_of).unwrap();
        assert_eq!(result.history.len(), 100);
        assert_eq!(result.history[0]["periodIndex"], 149);
        assert_eq!(result.history[99]["periodIndex"], 50);
        assert_eq!(result.totals["closedPeriods"], 150);
        assert_eq!(result.totals["movedAmount"], 15_000);
        assert_eq!(result.goal["currentAmount"], 0);
        assert_conserved(&result);
    }

    #[test]
    fn maximum_period_budget_fails_clearly_instead_of_truncating() {
        let mut input = goal();
        input["recurrenceUnit"] = json!("day");
        input["periodEndDate"] = json!("2024-01-02T00:00:00Z");
        let end = ts("2024-01-02T00:00:00Z");
        let last_allowed = project(&input, &[], end + (MAX_PERIODS - 2) * 86_400).unwrap();
        assert_eq!(last_allowed.totals["closedPeriods"], MAX_PERIODS - 1);
        let error = project(&input, &[], end + (MAX_PERIODS - 1) * 86_400).unwrap_err();
        assert!(error.contains("10000-period limit"));
    }

    #[test]
    fn thousands_of_unsorted_receipts_are_all_allocated_once() {
        let mut input = goal();
        input["recurrenceUnit"] = json!("day");
        input["periodEndDate"] = json!("2024-01-02T00:00:00Z");
        let start = ts("2024-01-01T00:00:00Z");
        let receipts: Vec<_> = (0..12_345)
            .rev()
            .map(|i| {
                json!({
                    "id": format!("hash-{i}"), "goalId":"goal", "amount": 1,
                    "issuedAt": start + (i % 150) * 86_400, "verified":true
                })
            })
            .collect();
        let result = project(&input, &receipts, start + 150 * 86_400).unwrap();
        assert_eq!(result.totals["receiptAmount"], 12_345);
        assert_eq!(result.totals["verifiedReceiptCount"], 12_345);
        assert_conserved(&result);
    }

    #[test]
    fn conservation_and_permutation_hold_across_rules_and_views() {
        let start = ts("2024-01-01T00:00:00Z");
        let mut seed = 42u64;
        let mut receipts = Vec::new();
        for i in 0..200 {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            receipts.push(
                json!({"id": format!("{i}"), "goalId":"goal", "amount":seed % 500 + 1,
                "issuedAt":start + ((seed >> 20) % 90) * 86_400, "verified":true}),
            );
        }
        for unit in ["day", "week", "month", "quarter", "half_year", "year"] {
            for sweep in ["target_amount", "entire_amount"] {
                for rollover in ["counts_as_progress", "reset_to_zero"] {
                    let mut input = goal();
                    input["currentAmount"] = json!(137);
                    input["recurrenceUnit"] = json!(unit);
                    input["sweepMode"] = json!(sweep);
                    input["rolloverMode"] = json!(rollover);
                    for days in [91, 180, 370] {
                        let as_of = start + days * 86_400;
                        let forward = project(&input, &receipts, as_of).unwrap();
                        receipts.reverse();
                        let reversed = project(&input, &receipts, as_of).unwrap();
                        assert_eq!(forward.goal, reversed.goal);
                        assert_eq!(forward.totals, reversed.totals);
                        assert_eq!(forward.history, reversed.history);
                        assert_conserved(&forward);
                    }
                }
            }
        }
    }
}
