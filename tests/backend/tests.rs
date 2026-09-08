use super::*;

// Deliberately hand-written test surface; production Guest still comes from WIT.
#[allow(dead_code)]
pub(crate) trait Guest {
    fn create_goal(payload: String) -> String;
    fn list_goals(payload: String) -> String;
    fn get_wallets(payload: String) -> String;
    fn update_goal(payload: String) -> String;
    fn delete_goal(payload: String) -> String;
    fn get_public_goal(payload: String) -> String;
    fn create_invoice(payload: String) -> String;
    fn invoice_status(payload: String) -> String;
    fn on_invoice_paid(payload: String) -> String;
    fn sweep_goal(payload: String) -> String;
    fn list_periods(payload: String) -> String;
    fn sweep_due(payload: String) -> String;
}
fn decode(s: String) -> Value {
    serde_json::from_str(&s).unwrap()
}
fn request() -> Value {
    json!({"walletId": host::WALLET, "title": "Mock goal", "goalAmount": 1000,
        "targetDate": "2030-01-31T12:30:00Z", "suggestedAmounts": [10, 100],
        "recurring": false, "walletMode": "all"})
}
fn setup() -> Value {
    host::reset();
    let goal = goal_from_request(&request(), "goal-a", host::WALLET, None).unwrap();
    host::seed("goals", goal.clone());
    goal
}
fn mint() -> Value {
    let result = decode(Component::create_invoice(
        json!({"goalId":"goal-a", "amount":100}).to_string(),
    ));
    assert!(result.get("paymentRequest").is_some(), "{result}");
    result
}
fn status(goal: &str, hash: &str) -> Value {
    decode(Component::invoice_status(
        json!({"goalId":goal, "paymentHash":hash}).to_string(),
    ))
}
fn deliver(event: Value) -> Value {
    decode(Component::on_invoice_paid(event.to_string()))
}
fn derived_total() -> u64 {
    decode(Component::get_public_goal(
        json!({"goalId":"goal-a"}).to_string(),
    ))["currentAmount"]
        .as_u64()
        .unwrap()
}
fn total() -> u64 {
    host::row("goals", "goal-a").unwrap()["currentAmount"]
        .as_u64()
        .unwrap()
}
fn no_receipt_or_credit() {
    assert_eq!(total(), 0);
    assert!(host::row("payment_events", host::HASH).is_none());
    assert_eq!(status("goal-a", host::HASH), json!({"paid":false}));
}

#[test]
fn invoice_host_uses_native_string_pairs_and_decimal_amount_metadata() {
    setup();
    mint();
    let pairs = host::state(|s| s.invoices.last().unwrap().extra.clone());
    assert_eq!(pairs.len(), 5);
    assert!(pairs
        .iter()
        .any(|(key, value)| key == "amount" && value == "100"));
    let extra = host::native_extra(&pairs);
    assert!(extra.as_object().unwrap().values().all(Value::is_string));
    assert_eq!(deliver(host::last_event())["updated"], true);
    assert_eq!(derived_total(), 100);
    let wit = include_str!("../../wasm/wit/world.wit");
    assert!(wit.contains("extra: list<tuple<string, string>>"));
    assert!(!wit.contains("extra-json"));
}
#[test]
fn invalid_decimal_metadata_amounts_are_quarantined() {
    for amount in [
        json!(100),
        json!("+100"),
        json!(" 100"),
        json!("100.0"),
        json!("1e2"),
        json!(""),
        json!("18446744073709551616"),
        Value::Null,
    ] {
        setup();
        mint();
        let mut event = host::last_event();
        event["extra"]["extra_zapgoalswasm"]["amount"] = amount;
        assert_eq!(deliver(event)["quarantined"], true);
        no_receipt_or_credit();
    }
}

#[test]
fn validates_calendar_and_requires_rfc3339_timezone_before_goal_write() {
    for bad in [
        "",
        "tomorrow",
        "2030-02-30T12:00:00Z",
        "2030-01-01",
        "2030-01-01T12:00:00",
        "2030-13-01T00:00:00Z",
        "2030-01-01T24:00:00Z",
        "2030-01-01T00:00:00+25:00",
    ] {
        setup();
        let mut req = request();
        req["targetDate"] = json!(bad);
        assert!(
            decode(Component::create_goal(req.to_string()))
                .get("error")
                .is_some(),
            "{bad}"
        );
        assert!(host::state(|s| s.writes.is_empty()));
    }
}
#[test]
fn invalid_target_update_leaves_existing_goal_untouched() {
    let before = setup();
    let mut req = request();
    req["goalId"] = json!("goal-a");
    req["targetDate"] = json!("bad");
    assert!(decode(Component::update_goal(req.to_string()))
        .get("error")
        .is_some());
    assert_eq!(host::row("goals", "goal-a").unwrap(), before);
    assert!(host::state(|s| s.writes.is_empty()));
}
#[test]
fn normalizes_offset_to_utc_and_keeps_subseconds() {
    assert_eq!(
        normalize_date("2030-01-31T23:30:00.123456789-02:00").unwrap(),
        "2030-02-01T01:30:00.123456789Z"
    );
    setup();
    let mut req = request();
    req["targetDate"] = json!("2030-01-31T23:30:00-02:00");
    let goal = decode(Component::create_goal(req.to_string()));
    assert_eq!(goal["targetDate"], "2030-02-01T01:30:00Z");
}
#[test]
fn clamp_31_to_actual_month_length_and_restore_explicit_anchor() {
    let feb = next_period_end("2028-01-31T12:00:00Z", "month", 1, 31).unwrap();
    assert_eq!(feb, "2028-02-29T12:00:00Z");
    assert_eq!(
        next_period_end(&feb, "month", 1, 31).unwrap(),
        "2028-03-31T12:00:00Z"
    );
    assert_eq!(
        next_period_end("2027-01-31T12:00:00Z", "month", 1, 31).unwrap(),
        "2027-02-28T12:00:00Z"
    );
    assert_eq!(
        next_period_end("2028-03-31T12:00:00Z", "month", 1, 31).unwrap(),
        "2028-04-30T12:00:00Z"
    );
    assert_eq!(
        next_period_end("2028-04-30T12:00:00Z", "month", 1, 30).unwrap(),
        "2028-05-30T12:00:00Z"
    );
}
#[test]
fn utc_month_arithmetic_uses_normalized_calendar_and_preserves_time() {
    assert_eq!(
        next_period_end("2028-01-31T23:30:00.125-02:00", "month", 1, 0).unwrap(),
        "2028-03-01T01:30:00.125Z"
    );
    assert_eq!(
        next_period_end("2028-03-01T01:30:00+02:00", "month", 1, 0).unwrap(),
        "2028-03-29T23:30:00Z"
    );
}
#[test]
fn all_recurrence_units_are_checked_and_calendar_correct() {
    let start = "2028-02-29T23:59:59.5Z";
    for (unit, expected) in [
        ("day", "2028-03-01T23:59:59.5Z"),
        ("week", "2028-03-07T23:59:59.5Z"),
        ("quarter", "2028-05-29T23:59:59.5Z"),
        ("half_year", "2028-08-29T23:59:59.5Z"),
        ("year", "2029-02-28T23:59:59.5Z"),
    ] {
        assert_eq!(next_period_end(start, unit, 1, 0).unwrap(), expected);
    }
    for unit in ["day", "week", "month", "quarter", "half_year", "year"] {
        assert!(next_period_end("9999-12-31T23:59:59Z", unit, 365, 0).is_err());
    }
    for interval in [0, 366, u64::MAX] {
        assert!(next_period_end(start, "month", interval, 0).is_err());
    }
    assert!(next_period_end(start, "month", 1, 32).is_err());
    assert!(next_period_end(start, "week", 1, 31).is_err());
    assert!(next_period_end(start, "invalid", 1, 0).is_err());
    assert!(normalize_date("0000-01-01T00:00:00+01:00").is_err());
    assert!(normalize_date("9999-12-31T23:59:59-01:00").is_err());
}
#[test]
fn invalid_schedule_inputs_fail_instead_of_silent_defaults() {
    setup();
    for (field, invalid) in [
        ("recurrenceInterval", json!(0)),
        ("recurrenceInterval", json!(366)),
        ("recurrenceInterval", json!("1")),
        ("recurrenceDayOfMonth", json!(32)),
        ("recurrenceDayOfMonth", json!(-1)),
    ] {
        let mut req = request();
        req[field] = invalid;
        assert!(goal_from_request(&req, "goal-a", host::WALLET, None).is_err());
    }
}
#[test]
fn recurring_conversion_is_rejected_and_new_goal_has_real_creation_start() {
    let old = setup();
    let mut req = request();
    req["recurring"] = json!(true);
    assert!(goal_from_request(&req, "goal-a", host::WALLET, Some(&old)).is_err());
    let created = goal_from_request(&req, "goal-b", host::WALLET, None).unwrap();
    assert_eq!(created["periodStartDate"], "2026-01-01T00:00:00Z");
    assert_eq!(created["periodEndDate"], created["targetDate"]);
    assert_eq!(created["accountingVersion"], 1);
    assert!(
        utc_date(created["periodStartDate"].as_str().unwrap()).unwrap()
            < utc_date(created["periodEndDate"].as_str().unwrap()).unwrap()
    );
}
#[test]
fn recurring_schedule_is_preserved_and_normalized_on_full_update() {
    let mut old = setup();
    old["recurring"] = json!(true);
    old["periodIndex"] = json!(4);
    old["periodStartDate"] = json!("2030-01-31T23:00:00-02:00");
    old["periodEndDate"] = json!("2030-02-28T23:00:00-02:00");
    let mut req = request();
    req["recurring"] = json!(true);
    let updated = goal_from_request(&req, "goal-a", host::WALLET, Some(&old)).unwrap();
    assert_eq!(updated["periodIndex"], 4);
    assert_eq!(updated["periodStartDate"], old["periodStartDate"]);
    assert_eq!(updated["periodEndDate"], old["periodEndDate"]);
    req["recurring"] = json!(false);
    assert!(goal_from_request(&req, "goal-a", host::WALLET, Some(&old)).is_err());
}
#[test]
fn wallet_mode_is_vanilla_and_public_goal_contains_no_lnurl_or_private_wallet() {
    let mut goal = setup();
    assert_eq!(goal["walletMode"], "vanilla");
    goal["walletMode"] = json!("all");
    host::seed("goals", goal);
    let public = decode(Component::get_public_goal(
        json!({"goalId":"goal-a"}).to_string(),
    ));
    assert_eq!(public["walletMode"], "vanilla");
    assert!(public.get("lnurlPath").is_none());
    assert!(public.get("walletId").is_none());
    let listed = decode(Component::list_goals("{}".into()));
    assert_eq!(listed["data"][0]["walletMode"], "vanilla");
}
#[test]
fn invalid_or_closed_invoice_requests_do_not_append_or_create() {
    for amount in [
        json!(0),
        json!(-1),
        json!(1.5),
        json!(MAX_SATS + 1),
        json!("100"),
    ] {
        setup();
        assert!(decode(Component::create_invoice(
            json!({"goalId":"goal-a", "amount":amount}).to_string()
        ))
        .get("error")
        .is_some());
        assert!(host::state(|s| s.calls.is_empty()));
    }
    for date in ["2020-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "invalid"] {
        let mut goal = setup();
        goal["targetDate"] = json!(date);
        host::seed("goals", goal);
        assert!(decode(Component::create_invoice(
            json!({"goalId":"goal-a", "amount":100}).to_string()
        ))
        .get("error")
        .is_some());
        assert!(host::state(|s| s.calls.is_empty()));
    }
    setup();
    assert!(decode(Component::create_invoice(
        json!({"goalId":"goal-a", "amount":100, "comment":"x".repeat(281)}).to_string()
    ))
    .get("error")
    .is_some());
    assert!(host::state(|s| s.calls.is_empty()));
}
#[test]
fn issuance_is_private_durable_before_creation_and_not_in_public_response_or_memo() {
    setup();
    let response = mint();
    let event = host::last_event();
    let extra = &event["extra"]["extra_zapgoalswasm"];
    let issue_id = extra["issueId"].as_str().unwrap();
    let issuance = host::row("invoice_issuances", issue_id).unwrap();
    assert_eq!(issuance["goalId"], "goal-a");
    assert_eq!(issuance["amount"], 100);
    assert_eq!(issuance.as_object().unwrap().len(), 4);
    assert!(!response.to_string().contains(issue_id));
    assert!(!response.to_string().contains(host::WALLET));
    assert_eq!(response.as_object().unwrap().len(), 3);
    assert_eq!(
        host::state(|s| s.calls.clone()),
        vec!["append:invoice_issuances", "create_invoice_public"]
    );
    assert_eq!(status("goal-a", host::HASH), json!({"paid":false}));
}
#[test]
fn early_settlement_before_invoice_host_returns_is_verified_and_visible() {
    setup();
    host::state(|s| s.settle_during_create = true);
    mint();
    assert_eq!(
        host::state(|s| s.early_result.clone()).unwrap()["updated"],
        true
    );
    assert_eq!(total(), 0);
    assert_eq!(derived_total(), 100);
    assert_eq!(
        host::row("payment_events", host::HASH).unwrap()["verified"],
        true
    );
    assert_eq!(status("goal-a", host::HASH), json!({"paid":true}));
}
#[test]
fn append_denial_limit_or_empty_id_never_creates_invoice() {
    for cap in [false, true] {
        setup();
        host::state(|s| {
            s.deny_append = !cap;
            if cap {
                s.append_limit = 0;
            }
        });
        assert!(std::panic::catch_unwind(|| Component::create_invoice(
            json!({"goalId":"goal-a", "amount":100}).to_string()
        ))
        .is_err());
        assert!(host::state(|s| s.invoices.is_empty()));
        no_receipt_or_credit();
    }
    setup();
    host::state(|s| s.empty_append_id = true);
    assert!(decode(Component::create_invoice(
        json!({"goalId":"goal-a", "amount":100}).to_string()
    ))
    .get("error")
    .is_some());
    assert!(host::state(|s| s.invoices.is_empty()));
    no_receipt_or_credit();
}
#[test]
fn invoice_creation_failure_leaves_only_uncredited_private_issuance() {
    setup();
    host::state(|s| s.fail_invoice = true);
    assert!(std::panic::catch_unwind(|| Component::create_invoice(
        json!({"goalId":"goal-a", "amount":100}).to_string()
    ))
    .is_err());
    assert_eq!(
        host::state(|s| s
            .rows
            .keys()
            .filter(|(table, _)| table == "invoice_issuances")
            .count()),
        1
    );
    no_receipt_or_credit();
}
#[test]
fn valid_event_records_verified_receipt_and_duplicate_does_not_double_credit() {
    setup();
    mint();
    let event = host::last_event();
    assert_eq!(deliver(event.clone())["updated"], true);
    assert_eq!(total(), 0);
    assert_eq!(derived_total(), 100);
    assert_eq!(deliver(event)["duplicate"], true);
    assert_eq!(total(), 0);
    assert_eq!(derived_total(), 100);
    assert_eq!(
        host::state(|s| s
            .writes
            .iter()
            .filter(|(t, _)| t == "payment_events")
            .count()),
        1
    );
}
#[test]
fn requires_explicit_host_success_and_pending_false() {
    for (field, value) in [
        ("pending", json!(true)),
        ("pending", Value::Null),
        ("pending", json!(0)),
        ("status", json!("paid")),
        ("status", json!("settled")),
        ("status", json!("failed")),
        ("status", json!("")),
        ("status", Value::Null),
    ] {
        setup();
        mint();
        let mut event = host::last_event();
        event[field] = value;
        assert_eq!(deliver(event)["ignored"], true);
        no_receipt_or_credit();
    }
    for key in ["pending", "status"] {
        setup();
        mint();
        let mut event = host::last_event();
        event.as_object_mut().unwrap().remove(key);
        assert_eq!(deliver(event)["ignored"], true);
        no_receipt_or_credit();
    }
}
#[test]
fn rejects_wrong_private_wallet_and_ignores_nested_wallet_claims() {
    for wallet in [json!("attacker-wallet"), json!(""), Value::Null] {
        setup();
        mint();
        let mut event = host::last_event();
        event["walletId"] = wallet;
        event["payment"] = json!({"walletId":host::WALLET,"wallet_id":host::WALLET});
        assert_eq!(deliver(event)["quarantined"], true);
        no_receipt_or_credit();
    }
}
#[test]
fn missing_or_forged_issuance_is_quarantined_including_historical_invoice() {
    for binding in [
        json!({"goalId":"goal-a", "amount":100}),
        json!({"goalId":"goal-a", "amount":100, "issueId":"guessed-secret"}),
    ] {
        setup();
        assert_eq!(deliver(host::event(binding))["quarantined"], true);
        no_receipt_or_credit();
        assert!(!host::state(|s| s.logs.is_empty()));
    }
}
#[test]
fn generic_source_id_goal_id_or_nested_extra_is_not_invoice_binding() {
    for form in 0..3 {
        setup();
        mint();
        let mut event = host::last_event();
        let original = event["extra"].clone();
        event["extra"] = match form {
            0 => json!({"source_id":"goal-a"}),
            1 => json!({"goalId":"goal-a"}),
            _ => Value::Null,
        };
        event["payment"] = json!({"extra":original, "extraJson":original});
        assert_eq!(deliver(event)["quarantined"], true);
        no_receipt_or_credit();
    }
}
#[test]
fn existing_issuance_must_match_goal_id_amount_and_own_row_id() {
    for (field, value) in [
        ("goalId", json!("goal-b")),
        ("amount", json!(101)),
        ("id", json!("wrong-row-id")),
    ] {
        setup();
        mint();
        let event = host::last_event();
        let issue_id = event["extra"]["extra_zapgoalswasm"]["issueId"]
            .as_str()
            .unwrap()
            .to_string();
        host::state(|s| {
            s.rows
                .get_mut(&("invoice_issuances".into(), issue_id))
                .unwrap()[field] = value
        });
        assert_eq!(deliver(event)["quarantined"], true);
        no_receipt_or_credit();
    }
}
#[test]
fn actual_amount_is_whole_positive_msats_and_matches_private_sats() {
    for amount in [
        json!(0),
        json!(-100000),
        json!(100001),
        json!(101000),
        json!((MAX_SATS + 1) * 1000),
        json!("100000"),
        Value::Null,
    ] {
        setup();
        mint();
        let mut event = host::last_event();
        event["amount"] = amount;
        event["payment"] = json!({"amount":100000});
        assert_eq!(deliver(event)["quarantined"], true);
        no_receipt_or_credit();
    }
    setup();
    mint();
    let mut event = host::last_event();
    event["extra"]["extra_zapgoalswasm"]["amount"] = json!(101);
    assert_eq!(deliver(event)["quarantined"], true);
    no_receipt_or_credit();
}
#[test]
fn rejects_non_hex_or_wrong_length_hashes_before_any_credit() {
    for hash in [
        "",
        "a",
        &"g".repeat(64),
        &"a".repeat(63),
        &"a".repeat(65),
        &"é".repeat(32),
    ] {
        setup();
        mint();
        let mut event = host::last_event();
        event["paymentHash"] = json!(hash);
        assert_eq!(deliver(event)["quarantined"], true);
        no_receipt_or_credit();
    }
}
#[test]
fn hashes_are_canonicalized_without_creating_duplicate_receipts() {
    setup();
    mint();
    let mut event = host::last_event();
    event["paymentHash"] = json!(host::HASH.to_uppercase());
    assert_eq!(deliver(event)["updated"], true);
    assert_eq!(deliver(host::last_event())["duplicate"], true);
    assert_eq!(total(), 0);
    assert_eq!(derived_total(), 100);
    assert_eq!(status("goal-a", &host::HASH.to_uppercase())["paid"], true);
}
#[test]
fn forged_duplicate_cannot_trigger_total_recovery() {
    for field in ["walletId", "issueId"] {
        setup();
        mint();
        let event = host::last_event();
        assert_eq!(deliver(event.clone())["updated"], true);
        let mut goal = host::row("goals", "goal-a").unwrap();
        goal["currentAmount"] = json!(0);
        host::seed("goals", goal);
        let mut forged = event;
        if field == "walletId" {
            forged["walletId"] = json!("attacker");
        } else {
            forged["extra"]["extra_zapgoalswasm"]["issueId"] = json!("guessed");
        }
        assert_eq!(deliver(forged)["quarantined"], true);
        assert_eq!(total(), 0);
    }
}
#[test]
fn legacy_receipts_stay_unverified_and_never_restore_totals_or_status() {
    for verified in [None, Some(json!(false)), Some(json!("true"))] {
        setup();
        mint();
        let mut receipt = json!({"id":host::HASH, "goalId":"goal-a", "amount":100, "newTotal":999});
        if let Some(v) = verified {
            receipt["verified"] = v;
        }
        host::seed("payment_events", receipt.clone());
        assert_eq!(deliver(host::last_event())["quarantined"], true);
        assert_eq!(total(), 0);
        assert_eq!(host::row("payment_events", host::HASH).unwrap(), receipt);
        assert_eq!(status("goal-a", host::HASH), json!({"paid":false}));
    }
}
#[test]
fn verified_receipt_for_other_goal_or_amount_cannot_restore_totals() {
    for (goal_id, amount) in [("goal-b", 100), ("goal-a", 99)] {
        setup();
        mint();
        host::seed(
            "payment_events",
            json!({"id":host::HASH, "goalId":goal_id, "amount":amount, "newTotal":999, "verified":true}),
        );
        assert_eq!(deliver(host::last_event())["quarantined"], true);
        assert_eq!(total(), 0);
    }
}
#[test]
fn receipt_write_failure_does_not_change_goal_or_claim_paid() {
    setup();
    mint();
    host::state(|s| s.fail_write_once = Some("payment_events".into()));
    assert!(deliver(host::last_event()).get("error").is_some());
    no_receipt_or_credit();
    assert_eq!(deliver(host::last_event())["updated"], true);
    assert_eq!(total(), 0);
    assert_eq!(derived_total(), 100);
}
#[test]
fn event_never_writes_goal_and_replay_is_byte_identical() {
    setup();
    mint();
    host::state(|s| s.fail_write_once = Some("goals".into()));
    assert_eq!(deliver(host::last_event())["updated"], true);
    assert_eq!(total(), 0);
    assert_eq!(derived_total(), 100);
    let before = host::state(|s| s.rows.clone());
    host::state(|s| s.timestamp += 10000);
    assert_eq!(deliver(host::last_event())["duplicate"], true);
    assert_eq!(host::state(|s| s.rows.clone()), before);
    assert_eq!(
        host::state(|s| s.fail_write_once.clone()),
        Some("goals".into())
    );
    assert_eq!(status("goal-a", host::HASH)["paid"], true);
}
#[test]
fn status_reads_only_public_receipt_fields_and_matches_goal_exactly() {
    setup();
    mint();
    assert_eq!(deliver(host::last_event())["updated"], true);
    host::state(|s| s.reads.clear());
    assert_eq!(status("goal-a", host::HASH), json!({"paid":true}));
    assert_eq!(status("goal-b", host::HASH), json!({"paid":false}));
    assert_eq!(status("goal-a", &"b".repeat(64)), json!({"paid":false}));
    assert_eq!(status("goal-a", "invalid"), json!({"paid":false}));
    assert_eq!(status("", host::HASH), json!({"paid":false}));
    assert!(host::state(|s| s
        .reads
        .iter()
        .all(|(table, _, public)| table == "payment_events" && *public)));
    assert_eq!(host::state(|s| s.reads.len()), 3);
}
#[test]
fn large_goal_total_or_issuance_alone_is_never_payment_status_proof() {
    let mut goal = setup();
    goal["currentAmount"] = json!(5000);
    host::seed("goals", goal);
    mint();
    assert_eq!(status("goal-a", host::HASH), json!({"paid":false}));
}

fn recurring_goal() -> Value {
    let mut goal = setup();
    goal["recurring"] = json!(true);
    goal["periodStartDate"] = json!("2025-01-01T00:00:00Z");
    goal["periodEndDate"] = json!("2025-01-31T12:00:00Z");
    goal["recurrenceDayOfMonth"] = json!(31);
    goal["currentAmount"] = json!(1500);
    goal
}
#[test]
fn invalid_calendar_views_fail_without_any_ledger_or_goal_write() {
    for (field, value) in [
        ("recurrenceUnit", json!("bad")),
        ("recurrenceInterval", json!(0)),
        ("recurrenceDayOfMonth", json!(32)),
        ("periodIndex", json!(u64::MAX)),
    ] {
        let mut goal = recurring_goal();
        goal[field] = value;
        host::seed("goals", goal.clone());
        // Per-goal views keep the explicit error.
        for result in [
            Component::sweep_goal(json!({"goalId":"goal-a"}).to_string()),
            Component::list_periods(json!({"goalId":"goal-a"}).to_string()),
        ] {
            assert!(decode(result).get("error").is_some());
        }
        // The read-only batch view skips the unprojectable goal with a warning
        // instead of failing every other goal's summary.
        let batch = decode(Component::sweep_due("{}".into()));
        assert!(batch.get("error").is_none(), "{batch}");
        assert!(batch["data"].as_array().unwrap().is_empty());
        assert!(host::state(|s| s
            .logs
            .iter()
            .any(|entry| entry.starts_with("warning:Skipping unprojectable recurring goal goal-a"))));
        assert!(host::state(|s| s.writes.is_empty()));
        assert_eq!(host::row("goals", "goal-a").unwrap(), goal);
    }
}
#[test]
fn corrupt_legacy_recurring_goal_degrades_per_goal_and_never_fails_owner_lists() {
    // 0.3.x sweeps could store a "current" period starting in the future.
    // Such a goal stays listed with stored values plus an explicit marker,
    // never substitute totals, and remains archivable by its owner.
    let healthy = setup();
    let mut corrupt = recurring_goal();
    corrupt["id"] = json!("goal-bad");
    corrupt["title"] = json!("Legacy corrupt");
    corrupt["currentAmount"] = json!(121);
    corrupt["accountingVersion"] = json!(0);
    corrupt["periodIndex"] = json!(2);
    corrupt["periodStartDate"] = json!("2027-01-31T00:00:00Z");
    corrupt["periodEndDate"] = json!("2027-02-28T00:00:00Z");
    host::seed("goals", corrupt.clone());

    let list = decode(Component::list_goals("{}".into()));
    assert!(list.get("error").is_none(), "{list}");
    let rows = list["data"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    let bad = rows.iter().find(|row| row["id"] == "goal-bad").unwrap();
    assert_eq!(
        bad["accountingError"],
        "as_of precedes the accounting start; clock inconsistency"
    );
    assert_eq!(bad["accountingOnly"], true);
    assert_eq!(bad["legacyOpeningUnverified"], true);
    assert_eq!(bad["currentAmount"], 121);
    assert_eq!(bad["goalAmount"], 1000);
    assert!(bad.get("accountingTotals").is_none());
    assert!(bad.get("totals").is_none());
    let good = rows.iter().find(|row| row["id"] == "goal-a").unwrap();
    assert!(good.get("accountingError").is_none());
    assert_eq!(good["accountingTotals"]["currentAmount"], 0);

    // Public views and owner period views keep the explicit error.
    assert!(decode(Component::get_public_goal(
        json!({"goalId":"goal-bad"}).to_string()
    ))
    .get("error")
    .is_some());
    assert!(decode(Component::list_periods(
        json!({"goalId":"goal-bad"}).to_string()
    ))
    .get("error")
    .is_some());

    // A presentation edit commits and reports the saved goal with the marker.
    let updated = decode(Component::update_goal(
        json!({"goalId":"goal-bad", "title":"Legacy corrupt, retitled"}).to_string(),
    ));
    assert!(updated.get("error").is_none(), "{updated}");
    assert_eq!(updated["accountingError"], bad["accountingError"]);
    assert_eq!(host::row("goals", "goal-bad").unwrap()["title"], "Legacy corrupt, retitled");

    // Archiving removes it from the owner list; nothing was double-counted.
    assert_eq!(
        decode(Component::delete_goal(json!({"goalId":"goal-bad"}).to_string()))["archived"],
        true
    );
    let after = decode(Component::list_goals("{}".into()));
    assert!(after.get("error").is_none());
    assert_eq!(after["data"].as_array().unwrap().len(), 1);
    assert_eq!(after["data"][0]["id"], healthy["id"]);
    assert!(host::state(|s| s.writes.iter().all(|(table, _)| table == "goals")));
}
#[test]
fn all_views_and_sweeps_share_projection_and_never_mutate_inputs() {
    let mut goal = recurring_goal();
    goal["periodStartDate"] = json!("2025-01-01T02:00:00+02:00");
    goal["periodEndDate"] = json!("2025-01-31T14:00:00+02:00");
    goal["targetWalletId"] = json!(host::TARGET);
    host::seed("goals", goal.clone());
    host::state(|s| {
        s.timestamp = accounting::parse_timestamp(&json!("2025-02-01T00:00:00Z")).unwrap()
    });
    let before = host::state(|s| s.rows.clone());
    // Read-only views never mutate; the sweep ACTION is covered separately.
    let periods = decode(Component::list_periods(
        json!({"goalId":"goal-a"}).to_string(),
    ));
    assert_eq!(periods["totals"]["movedAmount"], 1000);
    assert_eq!(periods["totals"]["currentAmount"], 500);
    assert_eq!(periods["data"][0]["retainedAmount"], 0);
    assert_eq!(decode(Component::sweep_due("{}".into()))["totalSwept"], 0);
    assert_eq!(derived_total(), 500);
    assert_eq!(host::state(|s| s.rows.clone()), before);
    assert!(host::state(|s| s.writes.is_empty()));
    assert!(host::state(|s| s.sweep_invoices.is_empty()));
    assert!(host::state(|s| s.sweep_payments.is_empty()));
}

fn sweepable_goal() -> Value {
    let mut goal = recurring_goal();
    goal["targetWalletId"] = json!(host::TARGET);
    goal["periodStartDate"] = json!("2025-01-01T00:00:00Z");
    goal["periodEndDate"] = json!("2025-01-31T12:00:00Z");
    host::seed("goals", goal.clone());
    host::state(|s| {
        s.timestamp = accounting::parse_timestamp(&json!("2025-02-01T00:00:00Z")).unwrap()
    });
    goal
}
fn sweep() -> Value {
    decode(Component::sweep_goal(json!({"goalId":"goal-a"}).to_string()))
}
#[test]
fn manual_sweep_transfers_allocated_sats_to_target_wallet_exactly_once() {
    sweepable_goal();
    let result = sweep();
    assert_eq!(result["swept"], true, "{result}");
    assert_eq!(result["amount"], 1000);
    assert_eq!(result["sweptAmount"], 1000);
    assert_eq!(result["closedPeriods"], 1);
    // One internal invoice on the owner's target wallet, paid from the goal
    // wallet with the allocated amount as an exact maximum.
    let (invoice, payment) = host::state(|s| {
        (
            s.sweep_invoices.last().cloned(),
            s.sweep_payments.last().cloned(),
        )
    });
    let invoice = invoice.unwrap();
    assert_eq!(invoice.wallet_id, host::TARGET);
    assert_eq!(invoice.amount, 1000.0);
    assert_eq!(invoice.tag, "zapgoalswasm");
    assert!(invoice.extra.iter().any(|(k, v)| k == "goalId" && v == "goal-a"));
    assert!(invoice.extra.iter().any(|(k, v)| k == "sweepId" && v == "sweep:goal-a:1"));
    let payment = payment.unwrap();
    assert_eq!(payment.wallet_id, host::WALLET);
    assert_eq!(payment.max_sat, Some(1000));
    // The durable marker records completion.
    let marker = host::row("sweeps", "sweep:goal-a:1").unwrap();
    assert_eq!(marker["status"], "completed");
    assert_eq!(marker["amount"], 1000);
    assert_eq!(marker["goalId"], "goal-a");
    assert_eq!(marker["paymentHash"], result["paymentHash"]);
    // A repeated sweep at the same accounting state is an idempotent no-op.
    let duplicate = sweep();
    assert_eq!(duplicate["swept"], false, "{duplicate}");
    assert_eq!(duplicate["available"], 0);
    assert_eq!(host::state(|s| s.sweep_payments.len()), 1);
    // When a late payment raises the allocation but the covered marker is
    // already completed, the duplicate marker blocks a second transfer of the
    // same period range; only a NEW period count unlocks the difference.
    let mut marker = host::row("sweeps", "sweep:goal-a:1").unwrap();
    marker["amount"] = json!(400);
    host::seed("sweeps", marker);
    let revised = sweep();
    assert_eq!(revised["swept"], false, "{revised}");
    assert_eq!(revised["duplicate"], true);
    assert_eq!(revised["amount"], 400);
    assert_eq!(host::state(|s| s.sweep_payments.len()), 1);
    // Sweeps never credit goal progress or write receipts.
    assert!(host::row("payment_events", host::HASH).is_none());
    assert_eq!(derived_total(), 500);
}
#[test]
fn sweep_settlement_events_are_quarantined_and_never_credit_progress() {
    sweepable_goal();
    let result = sweep();
    let hash = result["paymentHash"].as_str().unwrap().to_string();
    // The target invoice settles into the target wallet; its event must be
    // quarantined even though the extra metadata names the goal.
    let event = json!({"walletId": host::TARGET, "pending": false, "status": "success",
        "paymentHash": hash, "amount": 1000000,
        "extra": {"extra_zapgoalswasm": {"goalId": "goal-a", "sweepId": "sweep:goal-a:1", "source": "sweep_target"}}});
    assert_eq!(deliver(event)["quarantined"], true);
    // A forged event claiming the goal's own wallet is also quarantined: the
    // sweep invoice has no private issuance binding.
    let forged = json!({"walletId": host::WALLET, "pending": false, "status": "success",
        "paymentHash": hash, "amount": 1000000,
        "extra": {"extra_zapgoalswasm": {"goalId": "goal-a", "sweepId": "sweep:goal-a:1", "source": "sweep_target"}}});
    assert_eq!(deliver(forged)["quarantined"], true);
    assert!(host::row("payment_events", &hash).is_none());
    assert_eq!(derived_total(), 500);
    assert_eq!(status("goal-a", &hash), json!({"paid": false}));
}
#[test]
fn pending_marker_blocks_and_failed_marker_retries_without_double_payment() {
    sweepable_goal();
    host::seed("sweeps", json!({"id": "sweep:goal-a:1", "goalId": "goal-a", "attempt": "other",
        "periodCount": 1, "amount": 1000, "targetWalletId": host::TARGET, "paymentHash": "",
        "checkingId": "", "status": "pending", "error": "", "createdAt": "1", "completedAt": ""}));
    let blocked = sweep();
    assert!(blocked.get("error").is_some(), "{blocked}");
    assert!(blocked["error"]
        .as_str()
        .unwrap()
        .contains("already in progress"));
    assert!(host::state(|s| s.sweep_invoices.is_empty()));
    assert!(host::state(|s| s.sweep_payments.is_empty()));
    // A failed marker (no payment happened) is retryable and pays exactly once.
    let mut failed = host::row("sweeps", "sweep:goal-a:1").unwrap();
    failed["status"] = json!("failed");
    failed["error"] = json!("previous attempt failed");
    host::seed("sweeps", failed);
    let retried = sweep();
    assert_eq!(retried["swept"], true, "{retried}");
    assert_eq!(host::state(|s| s.sweep_payments.len()), 1);
    assert_eq!(host::row("sweeps", "sweep:goal-a:1").unwrap()["status"], "completed");
}
#[test]
fn sweep_fails_closed_on_payment_error_and_records_the_failure() {
    sweepable_goal();
    host::state(|s| s.fail_pay = true);
    let failed = sweep();
    assert!(failed.get("error").is_some(), "{failed}");
    assert!(failed["error"].as_str().unwrap().contains("Insufficient balance"));
    let marker = host::row("sweeps", "sweep:goal-a:1").unwrap();
    assert_eq!(marker["status"], "failed");
    assert!(marker["error"].as_str().unwrap().contains("Insufficient balance"));
    // Retry after the wallet is funded pays exactly once.
    host::state(|s| s.fail_pay = false);
    let retried = sweep();
    assert_eq!(retried["swept"], true, "{retried}");
    assert_eq!(host::state(|s| s.sweep_payments.len()), 1);
    assert_eq!(host::row("sweeps", "sweep:goal-a:1").unwrap()["status"], "completed");
}
#[test]
fn sweep_validates_target_wallet_and_available_allocation_before_any_wallet_call() {
    // No target wallet configured.
    sweepable_goal();
    let mut goal = host::row("goals", "goal-a").unwrap();
    goal["targetWalletId"] = json!("");
    host::seed("goals", goal);
    assert!(sweep().get("error").is_some());
    // Target equal to the goal's own wallet.
    let mut goal = host::row("goals", "goal-a").unwrap();
    goal["targetWalletId"] = json!(host::WALLET);
    host::seed("goals", goal);
    assert!(sweep().get("error").is_some());
    // Target wallet not owned by the user.
    let mut goal = host::row("goals", "goal-a").unwrap();
    goal["targetWalletId"] = json!("attacker-wallet");
    host::seed("goals", goal);
    assert!(sweep().get("error").is_some());
    // Non-recurring goals are not sweepable.
    let mut goal = host::row("goals", "goal-a").unwrap();
    goal["targetWalletId"] = json!(host::TARGET);
    goal["recurring"] = json!(false);
    host::seed("goals", goal);
    let result = sweep();
    assert!(result.get("error").is_some());
    // Archived goals are not sweepable.
    let mut goal = host::row("goals", "goal-a").unwrap();
    goal["recurring"] = json!(true);
    goal["archived"] = json!(true);
    host::seed("goals", goal);
    assert!(sweep().get("error").is_some());
    // Nothing allocated yet: the active period has not closed.
    let mut goal = host::row("goals", "goal-a").unwrap();
    goal["archived"] = json!(false);
    goal["periodStartDate"] = json!("2025-02-01T00:00:00Z");
    goal["periodEndDate"] = json!("2025-03-01T00:00:00Z");
    host::seed("goals", goal);
    let nothing = sweep();
    assert_eq!(nothing["swept"], false, "{nothing}");
    assert_eq!(nothing["available"], 0);
    assert!(host::state(|s| s.sweep_invoices.is_empty()));
    assert!(host::state(|s| s.sweep_payments.is_empty()));
    assert!(host::state(|s| s.writes.iter().all(|(table, _)| table != "goals")));
}
#[test]
fn later_periods_add_new_allocation_and_sweep_transfers_only_the_difference() {
    sweepable_goal();
    assert_eq!(sweep()["amount"], 1000);
    // The next monthly period closes with no new receipts; its 500-sat carry
    // is allocated again, so only the difference is transferable.
    host::state(|s| {
        s.timestamp = accounting::parse_timestamp(&json!("2025-03-01T00:00:00Z")).unwrap()
    });
    let second = sweep();
    assert_eq!(second["swept"], true, "{second}");
    assert_eq!(second["amount"], 500);
    assert_eq!(second["closedPeriods"], 2);
    assert_eq!(second["sweptAmount"], 1500);
    assert_eq!(host::state(|s| s.sweep_payments.len()), 2);
    let marker = host::row("sweeps", "sweep:goal-a:2").unwrap();
    assert_eq!(marker["amount"], 500);
    assert_eq!(marker["status"], "completed");
    // Totals still conserve; goal accounting inputs were never mutated.
    let totals = decode(Component::list_periods(
        json!({"goalId":"goal-a"}).to_string(),
    ))["totals"]
        .clone();
    assert_eq!(totals["movedAmount"], 1500);
    assert_eq!(totals["currentAmount"], 0);
}
#[test]
fn partial_presentation_update_preserves_opening_schedule_private_fields_and_receipts() {
    setup();
    mint();
    deliver(host::last_event());
    let before = host::row("goals", "goal-a").unwrap();
    let receipt = host::row("payment_events", host::HASH).unwrap();
    let result = decode(Component::update_goal(
        json!({"goalId":"goal-a","title":"New title"}).to_string(),
    ));
    assert_eq!(result["currentAmount"], 100);
    assert_eq!(result["title"], "New title");
    let after = host::row("goals", "goal-a").unwrap();
    for (key, value) in before.as_object().unwrap() {
        if key != "title" && key != "updatedAt" {
            assert_eq!(&after[key], value, "{key}");
        }
    }
    assert_eq!(host::row("payment_events", host::HASH).unwrap(), receipt);
}
#[test]
fn partial_update_payload_contains_only_mandatory_and_requested_presentation_columns() {
    setup();
    let result = decode(Component::update_goal(json!({"goalId":"goal-a","title":"Changed","descriptionAbove":"New description","progressColor":"#ABCDEF"}).to_string()));
    assert!(result.get("error").is_none(), "{result}");
    let payload = host::state(|s| s.writes.last().unwrap().1.clone());
    let actual: BTreeSet<_> = payload
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    let expected: BTreeSet<_> = [
        "id",
        "walletId",
        "title",
        "goalAmount",
        "targetDate",
        "suggestedAmounts",
        "createdAt",
        "updatedAt",
        "descriptionAbove",
        "progressColor",
        "walletMode",
    ]
    .into_iter()
    .collect();
    assert_eq!(actual, expected);
    assert_eq!(payload["descriptionAbove"], "New description");
    assert_eq!(payload["progressColor"], "#ABCDEF");
}
#[test]
fn paused_edit_after_archive_preserves_archive_and_projects_fresh_stored_goal() {
    let before = setup();
    host::state(|s| s.archive_before_goal_set = true);
    let result = decode(Component::update_goal(
        json!({"goalId":"goal-a","title":"Paused edit"}).to_string(),
    ));
    assert_eq!(result["archived"], true);
    assert_eq!(result["title"], "Paused edit");
    let stored = host::row("goals", "goal-a").unwrap();
    assert_eq!(stored["archived"], true);
    for key in [
        "currentAmount",
        "periodStartDate",
        "periodEndDate",
        "periodIndex",
        "accountingVersion",
        "recurring",
        "recurrenceUnit",
        "recurrenceInterval",
        "recurrenceDayOfMonth",
        "targetWalletId",
        "sweepMode",
        "rolloverMode",
    ] {
        assert_eq!(stored[key], before[key], "{key}");
    }
    let writes = host::state(|s| s.writes.clone());
    assert_eq!(writes.len(), 2);
    let archive_keys: BTreeSet<_> = writes[0]
        .1
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        archive_keys,
        [
            "id",
            "walletId",
            "title",
            "goalAmount",
            "targetDate",
            "suggestedAmounts",
            "createdAt",
            "updatedAt",
            "archived"
        ]
        .into_iter()
        .collect()
    );
    assert_eq!(writes[0].1["archived"], true);
    assert!(writes[1].1.get("archived").is_none());
    let writes_before = host::state(|s| s.writes.len());
    assert!(decode(Component::update_goal(
        json!({"goalId":"goal-a","title":"Forbidden"}).to_string()
    ))
    .get("error")
    .is_some());
    assert_eq!(host::state(|s| s.writes.len()), writes_before);
    assert!(decode(Component::create_invoice(
        json!({"goalId":"goal-a","amount":100}).to_string()
    ))
    .get("error")
    .is_some());
}
#[test]
fn nonhex_legacy_receipt_ids_are_ignored_but_verified_nonhex_ids_fail_closed() {
    setup();
    host::seed(
        "payment_events",
        json!({"id":"legacy-unverified-id","goalId":"goal-a","amount":"old-data","verified":false}),
    );
    host::seed(
        "payment_events",
        json!({"id":"legacy-missing-verified","goalId":"goal-a"}),
    );
    assert_eq!(derived_total(), 0);
    let listed = decode(Component::list_goals("{}".into()));
    assert_eq!(listed["data"][0]["currentAmount"], 0);
    host::seed(
        "payment_events",
        json!({"id":"bad-verified-id","goalId":"goal-a","amount":100,"verified":true,"issuedAt":"1767225600"}),
    );
    assert!(decode(Component::get_public_goal(
        json!({"goalId":"goal-a"}).to_string()
    ))
    .get("error")
    .is_some());
    assert!(host::state(|s| s.writes.is_empty()));
}

#[test]
fn locked_accounting_rules_and_readonly_projection_fields_cannot_be_changed() {
    let goal = recurring_goal();
    host::seed("goals", goal);
    for (key, value) in [
        ("goalAmount", json!(2000)),
        ("targetDate", json!("2031-01-01T00:00:00Z")),
        ("recurring", json!(false)),
        ("walletId", json!("other")),
        ("recurrenceUnit", json!("year")),
        ("rolloverMode", json!("reset_to_zero")),
        ("currentAmount", json!(123)),
        ("periodIndex", json!(2)),
        ("accountingVersion", json!(1)),
        ("archived", json!(true)),
    ] {
        let mut req = json!({"goalId":"goal-a"});
        req[key] = value;
        assert!(
            decode(Component::update_goal(req.to_string()))
                .get("error")
                .is_some(),
            "{key}"
        );
    }
    assert!(host::state(|s| s.writes.is_empty()));
}
#[test]
fn archive_retains_inputs_denies_new_issuance_and_accepts_late_payment() {
    setup();
    mint();
    let event = host::last_event();
    let result = decode(Component::delete_goal(
        json!({"goalId":"goal-a"}).to_string(),
    ));
    assert_eq!(result["archived"], true);
    assert!(host::row("goals", "goal-a").is_some());
    assert!(decode(Component::create_invoice(
        json!({"goalId":"goal-a","amount":100}).to_string()
    ))
    .get("error")
    .is_some());
    assert_eq!(deliver(event)["updated"], true);
    assert_eq!(derived_total(), 100);
    assert_eq!(decode(Component::list_goals("{}".into()))["total"], 0);
    assert_eq!(host::state(|s| s.invoices.len()), 1);
}
fn seed_receipts(count: usize) {
    for i in 0..count {
        host::seed(
            "payment_events",
            json!({"id":format!("{:064x}",i+1),"goalId":"goal-a","amount":1,"verified":true,"issuedAt":"1767225600"}),
        );
    }
}
#[test]
fn stable_public_private_pagination_includes_more_than_ten_thousand_receipts() {
    setup();
    seed_receipts(12345);
    assert_eq!(derived_total(), 12345);
    let private = decode(Component::list_goals("{}".into()));
    assert_eq!(private["data"][0]["currentAmount"], 12345);
    assert_eq!(total(), 0);
    assert!(host::state(|s| s.writes.is_empty()));
}
#[test]
fn insertion_churn_retries_whole_snapshot_and_permanent_churn_fails_closed() {
    setup();
    seed_receipts(1001);
    host::state(|s| s.churn_reads = 1);
    assert_eq!(derived_total(), 1001);
    host::state(|s| {
        s.pagination_calls = 0;
        s.churn_reads = 100;
    });
    let result = decode(Component::get_public_goal(
        json!({"goalId":"goal-a"}).to_string(),
    ));
    assert!(result.get("error").is_some());
    assert!(result.get("currentAmount").is_none());
    assert!(host::state(|s| s.pagination_calls <= 9));
}
#[test]
fn duplicate_pages_fail_instead_of_truncating_or_double_counting() {
    setup();
    seed_receipts(1001);
    host::state(|s| s.duplicate_page = true);
    assert!(decode(Component::get_public_goal(
        json!({"goalId":"goal-a"}).to_string()
    ))
    .get("error")
    .is_some());
}
#[test]
fn immutable_issuance_time_allocates_late_settlement_to_closed_period() {
    setup();
    let mut req = request();
    req["recurring"] = json!(true);
    req["targetDate"] = json!("2026-01-02T00:00:00Z");
    req["recurrenceUnit"] = json!("day");
    let goal = goal_from_request(&req, "goal-a", host::WALLET, None).unwrap();
    host::seed("goals", goal);
    mint();
    host::state(|s| s.timestamp += 86400 * 2);
    assert_eq!(deliver(host::last_event())["updated"], true);
    let receipt = host::row("payment_events", host::HASH).unwrap();
    assert_eq!(receipt["issuedAt"], "1767225600");
    assert!(receipt.get("newTotal").is_none());
    assert_eq!(total(), 0);
    let view = decode(Component::get_public_goal(
        json!({"goalId":"goal-a"}).to_string(),
    ));
    assert_eq!(view["totals"]["movedAmount"], 100);
    assert_eq!(view["currentAmount"], 0);
    let history = decode(Component::list_periods(
        json!({"goalId":"goal-a"}).to_string(),
    ));
    assert_eq!(history["data"][1]["receivedAmount"], 100);
    let before = host::state(|s| s.rows.clone());
    deliver(host::last_event());
    Component::sweep_due("{}".into());
    assert_eq!(host::state(|s| s.rows.clone()), before);
}
#[test]
fn wit_removes_lnurl_and_defines_actual_append_and_status_surface() {
    let wit = include_str!("../../wasm/wit/world.wit");
    assert!(!wit.contains("lnurl"));
    assert!(wit.contains("export invoice-status:"));
    assert!(wit.contains("record storage-append-public-request { table: string, source-id: string, data-json: option<string> }"));
    assert!(wit.contains("record storage-append-public-response { id: string }"));
}
#[test]
fn schema_and_migration_make_legacy_receipts_unverified_and_define_private_issuances() {
    let schema: Value = serde_json::from_str(include_str!("../../storage/schema.json")).unwrap();
    let verified = schema["tables"]["payment_events"]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["name"] == "verified")
        .unwrap();
    assert_eq!(verified["type"], "boolean");
    assert_eq!(verified["default"], false);
    let fields = schema["tables"]["invoice_issuances"]["fields"]
        .as_array()
        .unwrap();
    assert_eq!(
        fields
            .iter()
            .map(|f| f["name"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["id", "goalId", "amount", "createdAt"]
    );
    let migration: Value = serde_json::from_str(include_str!(
        "../../storage/migrations/005_invoice_issuance.json"
    ))
    .unwrap();
    assert!(migration["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|op| op["table"] == "payment_events"
            && op["field"] == "verified"
            && op["default"] == false));
    assert!(migration["operations"]
        .as_array()
        .unwrap()
        .iter()
        .any(|op| op["op"] == "create_table"
            && op["table"] == "invoice_issuances"
            && op["fields"].as_array() == Some(fields)));
}
