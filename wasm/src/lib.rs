use serde_json::{json, Value};
use std::collections::BTreeSet;
mod accounting;

#[cfg(not(test))]
wit_bindgen::generate!({ path: "wit/world.wit", world: "zapgoals" });
#[cfg(not(test))]
use lnbits::extension::host;

// The native harness compiles this exact implementation with an in-memory host;
// no generated bindings, WASM runtime, LNbits instance, or real invoices involved.
#[cfg(test)]
#[path = "../../tests/backend/mock_host.rs"]
mod host;
#[cfg(test)]
#[path = "../../tests/backend/tests.rs"]
mod tests;
#[cfg(test)]
use tests::Guest;

const MAX_SATS: u64 = 2_100_000_000;

fn parse(payload: &str) -> Result<Value, String> {
    serde_json::from_str(payload).map_err(|_| "Invalid JSON request".to_string())
}
fn ok(value: Value) -> String {
    value.to_string()
}
fn err(message: &str) -> String {
    json!({"error": message}).to_string()
}
fn now() -> String {
    host::now().timestamp.to_string()
}
fn id() -> String {
    host::random_id(&host::RandomIdRequest {
        prefix: "zg".into(),
    })
    .id
}
fn get(table: &str, id: &str, public: bool) -> Option<Value> {
    let response = if public {
        host::storage_get_public(&host::StorageGetPublicRequest {
            table: table.into(),
            id: id.into(),
        })
    } else {
        host::storage_get(&host::StorageGetRequest {
            table: table.into(),
            id: id.into(),
        })
    };
    response
        .data_json
        .and_then(|value| serde_json::from_str(&value).ok())
}
fn set(table: &str, value: &Value) -> bool {
    host::storage_set(&host::StorageSetRequest {
        table: table.into(),
        data_json: Some(value.to_string()),
    })
    .ok
}
fn wallets() -> Vec<String> {
    host::list_user_wallets()
        .wallets
        .into_iter()
        .map(|w| w.id)
        .collect()
}
fn owns_wallet(wallet: &str) -> bool {
    wallets().iter().any(|item| item == wallet)
}
fn text(req: &Value, key: &str, max: usize) -> Result<String, String> {
    let value = req
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if value.contains('\0') || value.len() > max {
        return Err(format!("Invalid {key}"));
    }
    Ok(value)
}
fn color(req: &Value, key: &str, default: &str) -> Result<String, String> {
    let value = req.get(key).and_then(Value::as_str).unwrap_or(default);
    let valid = value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err(format!("Invalid {key}"));
    }
    Ok(value.to_uppercase())
}
fn amounts(req: &Value) -> Result<String, String> {
    let list = req
        .get("suggestedAmounts")
        .and_then(Value::as_array)
        .ok_or("suggestedAmounts is required")?;
    if list.is_empty() || list.len() > 4 {
        return Err("Provide one to four suggested amounts".into());
    }
    let mut result = Vec::new();
    for item in list {
        let amount = item.as_u64().ok_or("Suggested amounts must be integers")?;
        if amount == 0 || amount > MAX_SATS || result.contains(&amount) {
            return Err("Invalid suggested amount".into());
        }
        result.push(amount);
    }
    Ok(serde_json::to_string(&result).unwrap_or_else(|_| "[]".into()))
}

fn utc_date(value: &str) -> Result<time::OffsetDateTime, String> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
        .map_err(|_| "Invalid RFC3339 date".to_string())?
        .checked_to_offset(time::UtcOffset::UTC)
        .ok_or_else(|| "Date is outside the supported range".to_string())
}
fn normalize_date(value: &str) -> Result<String, String> {
    accounting::normalize_date(value)
}
#[cfg(test)]
fn next_period_end(start: &str, unit: &str, interval: u64, day: u64) -> Result<String, String> {
    accounting::calendar_boundary(start, unit, interval, day, 1)
}

// Receipt membership is append-only. Every read is ID-ordered and count checked;
// insertions during pagination retry the entire snapshot, never publish a prefix.
fn page(
    table: &str,
    goal_id: Option<&str>,
    public: bool,
    limit: u32,
    offset: u32,
) -> host::StoragePaginatedResponse {
    let filters = goal_id.map(|id| json!({"goalId": id}).to_string());
    if public {
        host::storage_get_public_paginated(&host::StoragePublicPaginatedRequest {
            table: table.into(),
            source_id: goal_id.unwrap_or("").into(),
            filters_json: filters,
            search: None,
            search_fields_json: None,
            sort_by: Some("id".into()),
            descending: false,
            limit,
            offset,
        })
    } else {
        host::storage_get_paginated(&host::StoragePaginatedRequest {
            table: table.into(),
            filters_json: filters,
            search: None,
            search_fields_json: None,
            sort_by: Some("id".into()),
            descending: false,
            limit,
            offset,
        })
    }
}
fn stable_rows(table: &str, goal_id: Option<&str>, public: bool) -> Result<Vec<Value>, String> {
    for _ in 0..3 {
        let first = page(table, goal_id, public, 1000, 0);
        let expected = first.total;
        let mut response = first;
        let mut rows = Vec::new();
        let mut ids = BTreeSet::new();
        let mut previous = String::new();
        let mut offset = 0u32;
        let mut valid = true;
        loop {
            if response.total != expected {
                valid = false;
                break;
            }
            let batch: Vec<Value> = serde_json::from_str(&response.rows_json)
                .map_err(|_| "Invalid storage page JSON".to_string())?;
            if batch.len() > 1000 || (batch.is_empty() && offset < expected) {
                valid = false;
                break;
            }
            for row in batch {
                let id = row
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty())
                    .ok_or("Storage page is missing row ID")?;
                if table == "payment_events"
                    && row.get("verified").and_then(Value::as_bool) == Some(true)
                    && payment_hash(id).as_deref() != Some(id)
                {
                    return Err("Receipt page contains an invalid canonical payment hash".into());
                }
                if goal_id.is_some() && row.get("goalId").and_then(Value::as_str) != goal_id {
                    return Err("Receipt page contains another goal".into());
                }
                if id <= previous.as_str() || !ids.insert(id.to_string()) {
                    valid = false;
                    break;
                }
                previous = id.to_string();
                rows.push(row);
            }
            if !valid {
                break;
            }
            offset = u32::try_from(rows.len()).map_err(|_| "Storage snapshot is too large")?;
            if offset >= expected {
                break;
            }
            response = page(table, goal_id, public, 1000, offset);
        }
        let final_count = page(table, goal_id, public, 1, 0).total;
        if valid
            && final_count == expected
            && rows.len() == expected as usize
            && ids.len() == expected as usize
        {
            return Ok(rows);
        }
    }
    Err("Storage changed during pagination; retry the complete accounting view".into())
}
fn projection(goal: &Value, public: bool) -> Result<accounting::Projection, String> {
    let goal_id = goal
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Goal id is missing")?;
    let receipts = stable_rows("payment_events", Some(goal_id), public)?;
    // Capture the clock AFTER the stable read; early settlements are included.
    accounting::project(goal, &receipts, host::now().timestamp)
}
fn projected_goal(goal: &Value, public: bool) -> Result<Value, String> {
    let projection = projection(goal, public)?;
    let mut result = public_goal(projection.goal);
    result["totals"] = projection.totals.clone();
    result["accountingTotals"] = projection.totals;
    result["accountingOnly"] = json!(true);
    result["legacyOpeningUnverified"] = json!(
        goal.get("accountingVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
    );
    Ok(result)
}

// Stored accounting inputs can be unprojectable after an upgrade, for example
// impossible period dates written by earlier versions. An owner listing keeps
// such a goal visible with its stored presentation values plus an explicit
// error marker so it can still be inspected and archived. Never substitute or
// partially derive totals for inconsistent state; public views keep the error.
fn degraded_goal(goal: &Value, error: &str) -> Value {
    let mut result = public_goal(goal.clone());
    result["accountingError"] = json!(error);
    result["accountingOnly"] = json!(true);
    result["legacyOpeningUnverified"] = json!(
        goal.get("accountingVersion")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
    );
    result
}

// Stock SQL upserts update only supplied columns, but INSERT validation still
// requires these mandatory columns. Never send stale accounting/archive state.
fn goal_write_payload(goal: &Value, presentation: Option<&Value>) -> Result<Value, String> {
    let mut payload = json!({});
    for key in [
        "id",
        "walletId",
        "title",
        "goalAmount",
        "targetDate",
        "suggestedAmounts",
        "createdAt",
        "updatedAt",
    ] {
        payload[key] = goal
            .get(key)
            .cloned()
            .ok_or_else(|| format!("Stored goal is missing {key}"))?;
    }
    if let Some(request) = presentation {
        for key in [
            "descriptionAbove",
            "descriptionBelow",
            "backgroundColor",
            "textColor",
            "progressColor",
            "remainderColor",
            "fontName",
            "fontWeight",
            "walletMode",
        ] {
            if request.get(key).is_some() || key == "walletMode" {
                payload[key] = goal
                    .get(key)
                    .cloned()
                    .ok_or_else(|| format!("Stored goal is missing {key}"))?;
            }
        }
    }
    Ok(payload)
}

fn goal_from_request(
    req: &Value,
    id: &str,
    wallet_id: &str,
    existing: Option<&Value>,
) -> Result<Value, String> {
    if let Some(existing) = existing {
        let recurring = existing
            .get("recurring")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut locked = vec![
            "walletId",
            "recurring",
            "recurrenceUnit",
            "recurrenceInterval",
            "recurrenceDayOfMonth",
            "targetWalletId",
            "sweepMode",
            "rolloverMode",
        ];
        if recurring {
            locked.extend(["goalAmount", "targetDate"]);
        }
        for key in locked {
            if let Some(value) = req.get(key) {
                if existing.get(key) != Some(value) {
                    return Err(format!("{key} is immutable; create a new goal"));
                }
            }
        }
        for key in [
            "currentAmount",
            "periodIndex",
            "periodStartDate",
            "periodEndDate",
            "createdAt",
            "updatedAt",
            "archived",
            "accountingVersion",
            "accountingTotals",
            "totals",
            "legacyOpeningUnverified",
        ] {
            if req.get(key).is_some() {
                return Err(format!("{key} is read-only"));
            }
        }
        let mut updated = existing.clone();
        for (key, max) in [
            ("title", 120),
            ("descriptionAbove", 2000),
            ("descriptionBelow", 2000),
            ("fontName", 64),
        ] {
            if req.get(key).is_some() {
                let value = text(req, key, max)?;
                if key == "title" && value.is_empty() {
                    return Err("Title is required".into());
                }
                updated[key] = json!(value);
            }
        }
        for (key, default) in [
            ("backgroundColor", "#FFFFFF"),
            ("textColor", "#111111"),
            ("progressColor", "#2E7D32"),
            ("remainderColor", "#E0E0E0"),
        ] {
            if req.get(key).is_some() {
                updated[key] = json!(color(req, key, default)?);
            }
        }
        if req.get("fontWeight").is_some() {
            updated["fontWeight"] = json!(req["fontWeight"]
                .as_u64()
                .filter(|v| [400, 600, 700, 800].contains(v))
                .ok_or("Invalid fontWeight")?);
        }
        if req.get("suggestedAmounts").is_some() {
            updated["suggestedAmounts"] = json!(amounts(req)?);
        }
        if !recurring {
            if req.get("goalAmount").is_some() {
                updated["goalAmount"] = json!(req["goalAmount"]
                    .as_u64()
                    .filter(|v| *v > 0 && *v <= MAX_SATS)
                    .ok_or("Invalid goal amount")?);
            }
            if req.get("targetDate").is_some() {
                updated["targetDate"] = json!(normalize_date(&text(req, "targetDate", 64)?)?);
            }
        }
        updated["walletMode"] = json!("vanilla");
        updated["updatedAt"] = json!(now());
        return Ok(updated);
    }
    let title = text(req, "title", 120)?;
    if title.is_empty() {
        return Err("Title is required".into());
    }
    let goal_amount = req
        .get("goalAmount")
        .and_then(Value::as_u64)
        .filter(|v| *v > 0 && *v <= MAX_SATS)
        .ok_or("Invalid goal amount")?;
    let target_date = text(req, "targetDate", 64)?;
    if target_date.is_empty() {
        return Err("Target date is required".into());
    }
    let target_date = normalize_date(&target_date)?;
    let suggested = amounts(req)?;
    let stamp = now();

    let recurring = req
        .get("recurring")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let recurrence_unit = {
        let unit = req
            .get("recurrenceUnit")
            .and_then(Value::as_str)
            .unwrap_or("month");
        if !["day", "week", "month", "quarter", "half_year", "year"].contains(&unit) {
            return Err("Invalid recurrence unit".into());
        }
        unit.to_string()
    };
    let recurrence_interval = match req.get("recurrenceInterval") {
        Some(value) => value
            .as_u64()
            .filter(|v| (1..=365).contains(v))
            .ok_or("Invalid recurrence interval")?,
        None => 1,
    };
    let recurrence_day_of_month = match req.get("recurrenceDayOfMonth") {
        Some(value) => value
            .as_u64()
            .filter(|v| *v <= 31)
            .ok_or("Invalid recurrence day of month")?,
        None => 0,
    };
    if recurrence_day_of_month > 0 && recurrence_unit != "month" {
        return Err("Day of month is only valid for monthly recurrence".into());
    }
    let target_wallet_id = text(req, "targetWalletId", 64)?;
    let rollover_mode = {
        let mode = req
            .get("rolloverMode")
            .and_then(Value::as_str)
            .unwrap_or("counts_as_progress");
        if !["counts_as_progress", "reset_to_zero"].contains(&mode) {
            return Err("Invalid rollover mode".into());
        }
        mode.to_string()
    };
    let sweep_mode = {
        let mode = req
            .get("sweepMode")
            .and_then(Value::as_str)
            .unwrap_or("target_amount");
        if !["target_amount", "entire_amount"].contains(&mode) {
            return Err("Invalid sweep mode".into());
        }
        mode.to_string()
    };

    let (period_index, period_start_date, period_end_date) = if recurring {
        let start = time::OffsetDateTime::from_unix_timestamp(
            host::now()
                .timestamp
                .try_into()
                .map_err(|_| "Invalid current time")?,
        )
        .map_err(|_| "Invalid current time")?
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| "Invalid current time")?;
        if utc_date(&target_date)? <= utc_date(&start)? {
            return Err("Recurring target date must be after creation".into());
        }
        accounting::calendar_boundary(
            &target_date,
            &recurrence_unit,
            recurrence_interval,
            recurrence_day_of_month,
            1,
        )?;
        (0u64, start, target_date.clone())
    } else {
        (0u64, String::new(), String::new())
    };

    Ok(json!({
        "id": id, "walletId": wallet_id, "title": title, "archived": false, "accountingVersion": 1,
        "descriptionAbove": text(req, "descriptionAbove", 2000)?,
        "descriptionBelow": text(req, "descriptionBelow", 2000)?,
        "goalAmount": goal_amount, "currentAmount": existing.and_then(|v| v.get("currentAmount")).and_then(Value::as_u64).unwrap_or(0),
        "targetDate": target_date, "suggestedAmounts": suggested,
        "walletMode": "vanilla",
        "backgroundColor": color(req, "backgroundColor", "#FFFFFF")?, "textColor": color(req, "textColor", "#111111")?,
        "progressColor": color(req, "progressColor", "#2E7D32")?, "remainderColor": color(req, "remainderColor", "#E0E0E0")?,
        "fontName": text(req, "fontName", 64)?, "fontWeight": req.get("fontWeight").and_then(Value::as_u64).filter(|v| [400,600,700,800].contains(v)).unwrap_or(400),
        "createdAt": existing.and_then(|v| v.get("createdAt")).and_then(Value::as_str).unwrap_or(&stamp), "updatedAt": stamp,
        "recurring": recurring, "recurrenceUnit": recurrence_unit, "recurrenceInterval": recurrence_interval,
        "recurrenceDayOfMonth": recurrence_day_of_month, "targetWalletId": target_wallet_id,
        "rolloverMode": rollover_mode, "sweepMode": sweep_mode,
        "periodIndex": period_index, "periodStartDate": period_start_date, "periodEndDate": period_end_date
    }))
}
fn public_goal(goal: Value) -> Value {
    let amount = goal.get("goalAmount").and_then(Value::as_u64).unwrap_or(1);
    let current = goal
        .get("currentAmount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let percent = ((current as f64 / amount as f64) * 100.0).min(100.0);
    let mut result = goal;
    result["percent"] = json!(percent);
    result["status"] = json!(
        if result.get("archived").and_then(Value::as_bool) == Some(true) {
            "archived"
        } else if current >= amount {
            "complete"
        } else {
            "active"
        }
    );
    result["walletMode"] = json!("vanilla");
    result
}
fn invoice_response(invoice: host::CreateInvoiceResponse) -> Value {
    json!({"paymentHash": invoice.payment_hash, "paymentRequest": invoice.payment_request, "checkingId": invoice.checking_id})
}
fn target_date_is_open(goal: &Value) -> bool {
    goal.get("targetDate")
        .and_then(Value::as_str)
        .and_then(|value| utc_date(value).ok())
        .map(|target| target.unix_timestamp_nanos() > host::now().timestamp as i128 * 1_000_000_000)
        .unwrap_or(false)
}

fn payment_hash(value: &str) -> Option<String> {
    if value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit()) {
        Some(value.to_ascii_lowercase())
    } else {
        None
    }
}

fn quarantine(reason: &str) -> String {
    // Do not create an unverified receipt: that could block legitimate recovery.
    // Historical invoices need an explicitly approved reconciliation path.
    host::log(&host::LogRequest {
        level: "warning".into(),
        message: format!("Invoice event quarantined: {reason}"),
    });
    ok(json!({"ignored": true, "quarantined": true, "reason": reason}))
}

// Manual sweep transfer: moves `available` allocated sats from the goal's
// receiving wallet to the owner's target wallet via an internal invoice. A
// pending marker is durable before any wallet call, so a duplicate request at
// the same accounting state never reaches payment. The claim is verified by
// read-back; an overwritten marker aborts before any funds move. The target
// invoice's settlement event carries sweep metadata but no issuance binding,
// so the settlement handler quarantines it: sweeps never credit goal progress.
fn sweep_transfer(
    goal_id: &str,
    goal: &Value,
    marker_id: &str,
    closed: u64,
    available: u64,
    target: &str,
    goal_wallet: &str,
    moved: u64,
    swept_total: u64,
) -> String {
    let attempt = id();
    let title = goal
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("goal");
    let marker = json!({"id": marker_id, "goalId": goal_id, "attempt": attempt, "periodCount": closed,
        "amount": available, "targetWalletId": target, "paymentHash": "", "checkingId": "",
        "status": "pending", "error": "", "createdAt": now(), "completedAt": ""});
    if !set("sweeps", &marker) {
        return err("Could not record the sweep; no payment was made");
    }
    match get("sweeps", marker_id, false) {
        Some(row) if row.get("attempt").and_then(Value::as_str) == Some(attempt.as_str()) => {}
        _ => return err("A concurrent sweep claim won; no payment was made"),
    }
    let invoice = host::create_invoice(&host::CreateInvoiceRequest {
        wallet_id: target.into(),
        amount: available as f64,
        currency: "sat".into(),
        memo: format!("ZapGoals sweep: {title}"),
        tag: "zapgoalswasm".into(),
        extra: vec![
            ("goalId".into(), goal_id.into()),
            ("sweepId".into(), marker_id.into()),
            ("source".into(), "sweep_target".into()),
        ],
    });
    if invoice.payment_hash.is_empty() || invoice.payment_request.is_empty() {
        fail_sweep(marker_id, "Could not create the target wallet invoice");
        return err("Sweep failed: could not create an invoice on the target wallet; no payment was made");
    }
    let payment = host::pay_invoice(&host::PayInvoiceRequest {
        wallet_id: goal_wallet.into(),
        payment_request: invoice.payment_request.clone(),
        max_sat: Some(available),
        description: format!("ZapGoals sweep: {title}"),
        extra: vec![
            ("goalId".into(), goal_id.into()),
            ("sweepId".into(), marker_id.into()),
        ],
    });
    if !payment.ok {
        let reason = payment
            .error
            .clone()
            .unwrap_or_else(|| "unknown payment error".into());
        fail_sweep(marker_id, &reason);
        return err(&format!(
            "Sweep payment failed: {reason}. No funds were transferred."
        ));
    }
    let checking_id = payment.checking_id.clone().unwrap_or_default();
    let pay_status = payment.status.clone().unwrap_or_default();
    let mut final_marker = marker;
    final_marker["paymentHash"] = json!(invoice.payment_hash);
    final_marker["checkingId"] = json!(checking_id);
    final_marker["status"] = json!("completed");
    final_marker["completedAt"] = json!(now());
    if !set("sweeps", &final_marker) {
        // The transfer was submitted but could not be recorded: fail closed so
        // a later sweep cannot double-pay before an owner reconciles this row.
        host::log(&host::LogRequest {
            level: "error".into(),
            message: format!(
                "Sweep {marker_id} transferred {available} sats but could not record completion; future sweeps are blocked until reconciled"
            ),
        });
        return err("The transfer was submitted but could not be recorded; reconcile this sweep before sweeping again");
    }
    ok(json!({"swept": true, "goalId": goal_id, "amount": available, "paymentHash": invoice.payment_hash,
        "checkingId": checking_id, "status": pay_status,
        "movedAmount": moved, "sweptAmount": swept_total + available, "available": 0, "closedPeriods": closed}))
}

fn fail_sweep(marker_id: &str, reason: &str) {
    if let Some(mut row) = get("sweeps", marker_id, false) {
        row["status"] = json!("failed");
        row["error"] = json!(reason);
        row["completedAt"] = json!(now());
        set("sweeps", &row);
    }
}

struct Component;

impl Guest for Component {
    fn create_goal(payload: String) -> String {
        let req = match parse(&payload) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        let wallet = match req.get("walletId").and_then(Value::as_str) {
            Some(v) if owns_wallet(v) => v,
            _ => return err("Wallet is not available to this user"),
        };
        let goal_id = id();
        match goal_from_request(&req, &goal_id, wallet, None) {
            Ok(goal) if set("goals", &goal) => match projected_goal(&goal, false) {
                Ok(v) => ok(v),
                Err(e) => err(&e),
            },
            Ok(_) => err("Could not save goal"),
            Err(e) => err(&e),
        }
    }
    fn list_goals(_payload: String) -> String {
        let goals = match stable_rows("goals", None, false) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        let mut rows = Vec::new();
        for goal in goals {
            if goal.get("archived").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            match projected_goal(&goal, false) {
                Ok(v) => rows.push(v),
                // One unprojectable goal (e.g. corrupt legacy periods) must not
                // hide every other goal from the owner's list.
                Err(e) => rows.push(degraded_goal(&goal, &e)),
            }
        }
        ok(json!({"total": rows.len(), "data": rows}))
    }
    fn get_wallets(_payload: String) -> String {
        let items: Vec<Value> = host::list_user_wallets()
            .wallets
            .into_iter()
            .map(|wallet| json!({"id": wallet.id, "name": wallet.name}))
            .collect();
        ok(json!({"data": items}))
    }
    fn update_goal(payload: String) -> String {
        let req = match parse(&payload) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        let goal_id = match req.get("goalId").and_then(Value::as_str) {
            Some(v) => v,
            None => return err("Goal id is required"),
        };
        let existing = match get("goals", goal_id, false) {
            Some(v) => v,
            None => return err("Goal not found"),
        };
        if existing.get("archived").and_then(Value::as_bool) == Some(true) {
            return err("Archived goals cannot be edited");
        }
        let wallet = existing
            .get("walletId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let goal = match goal_from_request(&req, goal_id, wallet, Some(&existing)) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        let payload = match goal_write_payload(&goal, Some(&req)) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        if !set("goals", &payload) {
            return err("Could not save goal");
        }
        // An archive may have committed after our initial read. Project only
        // fresh stored inputs, not the stale full clone used for validation.
        let stored = match get("goals", goal_id, false) {
            Some(v) => v,
            None => return err("Goal not found after update"),
        };
        match projected_goal(&stored, false) {
            // The presentation write above already committed; report the saved
            // goal with an explicit accounting marker rather than a failure.
            Err(e) => ok(degraded_goal(&stored, &e)),
            Ok(v) => ok(v),
        }
    }
    fn delete_goal(payload: String) -> String {
        let req = match parse(&payload) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        let goal_id = req.get("goalId").and_then(Value::as_str).unwrap_or("");
        let mut goal = match get("goals", goal_id, false) {
            Some(v) => v,
            None => return err("Goal not found"),
        };
        if goal.get("archived").and_then(Value::as_bool) != Some(true) {
            goal["updatedAt"] = json!(now());
            let mut payload = match goal_write_payload(&goal, None) {
                Ok(v) => v,
                Err(e) => return err(&e),
            };
            payload["archived"] = json!(true);
            if !set("goals", &payload) {
                return err("Could not archive goal");
            }
        }
        ok(json!({"archived": true, "goalId": goal_id}))
    }
    fn get_public_goal(payload: String) -> String {
        let req = match parse(&payload) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        let id = req.get("goalId").and_then(Value::as_str).unwrap_or("");
        match get("goals", id, true) {
            Some(goal) => match projected_goal(&goal, true) {
                Ok(v) => ok(v),
                Err(e) => err(&e),
            },
            None => err("Goal not found"),
        }
    }
    fn create_invoice(payload: String) -> String {
        let req = match parse(&payload) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        let id = req.get("goalId").and_then(Value::as_str).unwrap_or("");
        let goal = match get("goals", id, true) {
            Some(v) => v,
            None => return err("Goal not found"),
        };
        if goal.get("archived").and_then(Value::as_bool) == Some(true) {
            return err("This goal is archived");
        }
        let projected = match projected_goal(&goal, true) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        if !target_date_is_open(&projected) {
            return err("This goal has ended");
        }
        let amount = req
            .get("amount")
            .and_then(Value::as_u64)
            .filter(|v| *v > 0 && *v <= MAX_SATS)
            .unwrap_or(0);
        if amount == 0 {
            return err("Amount must be a positive satoshi amount");
        }
        let comment = req.get("comment").and_then(Value::as_str).unwrap_or("");
        if comment.len() > 280 {
            return err("Comment is too long");
        }
        // This durable, private, host-generated binding MUST precede invoice
        // creation: settlement can arrive before create_invoice_public returns.
        // The append policy injects goalId and accepts only amount/createdAt.
        let issuance = host::storage_append_public(&host::StorageAppendPublicRequest {
            table: "invoice_issuances".into(),
            source_id: id.into(),
            data_json: Some(json!({"amount": amount, "createdAt": now()}).to_string()),
        });
        if issuance.id.is_empty() {
            return err("Could not record invoice issuance");
        }
        // Stock CreateInvoicePublicRequest accepts native `extra`, not an
        // extra_json alias. WIT tuples become a dict through host validation.
        let extra = vec![
            ("goalId".into(), id.into()),
            ("amount".into(), amount.to_string()),
            ("issueId".into(), issuance.id),
            ("source".into(), "invoice".into()),
            ("comment".into(), comment.into()),
        ];
        let invoice = host::create_invoice_public(&host::CreateInvoicePublicRequest {
            source_id: id.into(),
            amount,
            currency: "sat".into(),
            memo: format!(
                "ZapGoals: {}",
                goal.get("title").and_then(Value::as_str).unwrap_or("Goal")
            ),
            extra,
        });
        ok(invoice_response(invoice))
    }
    fn invoice_status(payload: String) -> String {
        let req = match parse(&payload) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        let goal_id = req.get("goalId").and_then(Value::as_str).unwrap_or("");
        let hash = req
            .get("paymentHash")
            .and_then(Value::as_str)
            .and_then(payment_hash);
        let paid = if let Some(hash) = hash.filter(|_| !goal_id.is_empty()) {
            // Status returns only a boolean, never receipt fields or private issuance data.
            get("payment_events", &hash, true)
                .map(|receipt| {
                    receipt.get("goalId").and_then(Value::as_str) == Some(goal_id)
                        && receipt.get("verified").and_then(Value::as_bool) == Some(true)
                })
                .unwrap_or(false)
        } else {
            false
        };
        ok(json!({"paid": paid}))
    }
    fn on_invoice_paid(payload: String) -> String {
        let event = match parse(&payload) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        // These are the host's actual settlement fields. Missing values and
        // fallback nested/client metadata are not evidence of settlement.
        if event.get("pending").and_then(Value::as_bool) != Some(false)
            || event.get("status").and_then(Value::as_str) != Some("success")
        {
            return ok(json!({"ignored": true}));
        }
        let hash = match event
            .get("paymentHash")
            .and_then(Value::as_str)
            .and_then(payment_hash)
        {
            Some(hash) => hash,
            None => return quarantine("Invalid payment hash"),
        };
        let extra = match event
            .get("extra")
            .and_then(|v| v.get("extra_zapgoalswasm"))
            .and_then(Value::as_object)
        {
            Some(extra) => extra,
            None => return quarantine("Missing invoice issuance binding"),
        };
        let goal_id = extra.get("goalId").and_then(Value::as_str).unwrap_or("");
        let issue_id = extra.get("issueId").and_then(Value::as_str).unwrap_or("");
        if goal_id.is_empty() || issue_id.is_empty() {
            return quarantine("Missing invoice issuance binding");
        }
        let issuance = match get("invoice_issuances", issue_id, false) {
            Some(row) => row,
            None => return quarantine("Unknown invoice issuance"),
        };
        let amount_msat = event.get("amount").and_then(Value::as_u64).unwrap_or(0);
        if amount_msat == 0 || amount_msat % 1000 != 0 || amount_msat / 1000 > MAX_SATS {
            return quarantine("Invalid paid invoice amount");
        }
        let amount_sat = amount_msat / 1000;
        if issuance.get("id").and_then(Value::as_str) != Some(issue_id)
            || issuance.get("goalId").and_then(Value::as_str) != Some(goal_id)
            || issuance.get("amount").and_then(Value::as_u64) != Some(amount_sat)
            || extra
                .get("amount")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|value| value.parse::<u64>().ok())
                != Some(amount_sat)
        {
            return quarantine("Invoice issuance does not match payment");
        }
        let goal = match get("goals", goal_id, false) {
            Some(value) => value,
            None => return quarantine("Invoice goal not found"),
        };
        let actual_wallet = event.get("walletId").and_then(Value::as_str).unwrap_or("");
        let goal_wallet = goal.get("walletId").and_then(Value::as_str).unwrap_or("");
        if actual_wallet.is_empty() || goal_wallet.is_empty() || actual_wallet != goal_wallet {
            return quarantine("Paid invoice wallet does not match goal");
        }
        let issued_at = match issuance
            .get("createdAt")
            .and_then(|v| accounting::parse_timestamp(v).ok())
        {
            Some(timestamp) if timestamp <= host::now().timestamp => timestamp.to_string(),
            _ => return quarantine("Invalid private invoice issuance time"),
        };
        if let Some(processed) = get("payment_events", &hash, false) {
            if processed.get("verified").and_then(Value::as_bool) != Some(true)
                || processed.get("goalId").and_then(Value::as_str) != Some(goal_id)
                || processed.get("amount").and_then(Value::as_u64) != Some(amount_sat)
                || processed.get("issuedAt").and_then(Value::as_str) != Some(issued_at.as_str())
            {
                return quarantine("Existing receipt is unverified or mismatched");
            }
            return ok(json!({"duplicate": true, "goalId": goal_id}));
        }
        // Deterministic immutable contents make concurrent duplicate writes equal.
        // No currentAmount/newTotal recovery, period mutation, or delivery clock.
        let receipt = json!({"id": hash, "goalId": goal_id, "amount": amount_sat,
            "issuedAt": issued_at, "processedAt": issued_at, "verified": true});
        if !set("payment_events", &receipt) {
            return err("Could not record payment");
        }
        ok(json!({"updated": true, "goalId": goal_id, "amount": amount_sat}))
    }
    fn sweep_goal(payload: String) -> String {
        let req = match parse(&payload) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        let goal_id = req.get("goalId").and_then(Value::as_str).unwrap_or("");
        let goal = match get("goals", goal_id, false) {
            Some(v) => v,
            None => return err("Goal not found"),
        };
        if goal.get("recurring").and_then(Value::as_bool) != Some(true) {
            return err("Goal is not recurring");
        }
        if goal.get("archived").and_then(Value::as_bool) == Some(true) {
            return err("Archived goals cannot be swept");
        }
        let goal_wallet = goal
            .get("walletId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let target = goal
            .get("targetWalletId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if target.is_empty() {
            return err("No target wallet is configured for this goal");
        }
        if target == goal_wallet {
            return err("The target wallet must be different from the goal's wallet");
        }
        // Defense in depth on top of the host's own wallet-ownership checks.
        if !owns_wallet(&target) {
            return err("The target wallet is not available to this user");
        }
        let projection = match projection(&goal, false) {
            Ok(p) => p,
            Err(e) => return err(&e),
        };
        let closed = projection
            .totals
            .get("closedPeriods")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let moved = projection
            .totals
            .get("movedAmount")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        // Completed sweeps are durable, append-only facts; the transferable
        // amount is what closed periods allocated minus what already moved.
        let sweeps = match stable_rows("sweeps", Some(goal_id), false) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        let mut swept_total: u64 = 0;
        for row in &sweeps {
            if row.get("goalId").and_then(Value::as_str) != Some(goal_id)
                || row.get("status").and_then(Value::as_str) != Some("completed")
            {
                continue;
            }
            swept_total = match swept_total.checked_add(
                row.get("amount").and_then(Value::as_u64).unwrap_or(0),
            ) {
                Some(total) => total,
                None => return err("Sweep accounting overflow; reconcile manually"),
            };
        }
        if swept_total > moved {
            return err("Recorded sweeps exceed the current allocation; reconcile this goal manually before sweeping again");
        }
        let available = moved - swept_total;
        if available == 0 {
            return ok(json!({"swept": false, "goalId": goal_id, "reason": "Nothing available to sweep yet",
                "movedAmount": moved, "sweptAmount": swept_total, "available": 0, "closedPeriods": closed}));
        }
        // The marker id is deterministic per covered period count: a second
        // click (or request) at the same accounting state hits the existing
        // marker and never reaches wallet calls. Failed markers are retryable.
        let marker_id = format!("sweep:{goal_id}:{closed}");
        if let Some(existing) = get("sweeps", &marker_id, false) {
            return match existing.get("status").and_then(Value::as_str) {
                Some("completed") => ok(json!({"swept": false, "duplicate": true, "goalId": goal_id,
                    "paymentHash": existing.get("paymentHash").cloned().unwrap_or(json!("")),
                    "amount": existing.get("amount").cloned().unwrap_or(json!(0)),
                    "movedAmount": moved, "sweptAmount": swept_total, "available": 0, "closedPeriods": closed})),
                Some("pending") => err("A sweep for this goal is already in progress; no payment was made"),
                _ => sweep_transfer(goal_id, &goal, &marker_id, closed, available, &target, &goal_wallet, moved, swept_total),
            };
        }
        sweep_transfer(goal_id, &goal, &marker_id, closed, available, &target, &goal_wallet, moved, swept_total)
    }
    fn list_periods(payload: String) -> String {
        let req = match parse(&payload) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        let goal_id = req.get("goalId").and_then(Value::as_str).unwrap_or("");
        let goal = match get("goals", goal_id, false) {
            Some(v) => v,
            None => return err("Goal not found"),
        };
        match projection(&goal, false) {
            Ok(p) => ok(
                json!({"total":p.totals["closedPeriods"],"data":p.history,"totals":p.totals,"accountingOnly":true,"latePaymentsMayRevise":true}),
            ),
            Err(e) => err(&e),
        }
    }
    fn sweep_due(_payload: String) -> String {
        let goals = match stable_rows("goals", None, false) {
            Ok(v) => v,
            Err(e) => return err(&e),
        };
        let mut views = Vec::new();
        for goal in goals {
            if goal.get("recurring").and_then(Value::as_bool) != Some(true)
                || goal.get("archived").and_then(Value::as_bool) == Some(true)
            {
                continue;
            }
            match projection(&goal, false) {
                Ok(p) => views.push(json!({"goalId":goal["id"],"goal":p.goal,"totals":p.totals})),
                // A batch, read-only view skips unprojectable goals with a
                // warning instead of failing every other goal's summary.
                Err(e) => {
                    host::log(&host::LogRequest {
                        level: "warning".into(),
                        message: format!(
                            "Skipping unprojectable recurring goal {}: {e}",
                            goal.get("id").and_then(Value::as_str).unwrap_or("?")
                        ),
                    });
                }
            }
        }
        ok(
            json!({"data":views,"total":views.len(),"accountingOnly":true,"readOnly":true,"totalSwept":0}),
        )
    }
}
#[cfg(not(test))]
export!(Component);
