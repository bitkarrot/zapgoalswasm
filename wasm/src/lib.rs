use serde_json::{json, Value};

wit_bindgen::generate!({ path: "wit/world.wit", world: "zapgoals" });
use lnbits::extension::host;

const MAX_SATS: u64 = 2_100_000_000;

fn parse(payload: &str) -> Result<Value, String> {
    serde_json::from_str(payload).map_err(|_| "Invalid JSON request".to_string())
}
fn ok(value: Value) -> String { value.to_string() }
fn err(message: &str) -> String { json!({"error": message}).to_string() }
fn lnurl_err(message: &str) -> String { json!({"status": "ERROR", "reason": message}).to_string() }
fn now() -> String { host::now().timestamp.to_string() }
fn id() -> String { host::random_id(&host::RandomIdRequest { prefix: "zg".into() }).id }
fn get(table: &str, id: &str, public: bool) -> Option<Value> {
    let response = if public {
        host::storage_get_public(&host::StorageGetPublicRequest { table: table.into(), id: id.into() })
    } else {
        host::storage_get(&host::StorageGetRequest { table: table.into(), id: id.into() })
    };
    response.data_json.and_then(|value| serde_json::from_str(&value).ok())
}
fn set(table: &str, value: &Value) -> bool {
    host::storage_set(&host::StorageSetRequest { table: table.into(), data_json: Some(value.to_string()) }).ok
}
fn delete(table: &str, id: &str) -> bool {
    host::storage_delete(&host::StorageDeleteRequest { table: table.into(), id: id.into() }).ok
}
fn wallets() -> Vec<String> { host::list_user_wallets().wallets.into_iter().map(|w| w.id).collect() }
fn owns_wallet(wallet: &str) -> bool { wallets().iter().any(|item| item == wallet) }
fn text(req: &Value, key: &str, max: usize) -> Result<String, String> {
    let value = req.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
    if value.contains('\0') || value.len() > max { return Err(format!("Invalid {key}")); }
    Ok(value)
}
fn color(req: &Value, key: &str, default: &str) -> Result<String, String> {
    let value = req.get(key).and_then(Value::as_str).unwrap_or(default);
    let valid = value.len() == 7 && value.starts_with('#') && value[1..].chars().all(|c| c.is_ascii_hexdigit());
    if !valid { return Err(format!("Invalid {key}")); }
    Ok(value.to_uppercase())
}
fn amounts(req: &Value) -> Result<String, String> {
    let list = req.get("suggestedAmounts").and_then(Value::as_array).ok_or("suggestedAmounts is required")?;
    if list.is_empty() || list.len() > 4 { return Err("Provide one to four suggested amounts".into()); }
    let mut result = Vec::new();
    for item in list {
        let amount = item.as_u64().ok_or("Suggested amounts must be integers")?;
        if amount == 0 || amount > MAX_SATS || result.contains(&amount) { return Err("Invalid suggested amount".into()); }
        result.push(amount);
    }
    Ok(serde_json::to_string(&result).unwrap_or_else(|_| "[]".into()))
}

fn months_per_unit(unit: &str) -> Option<i32> {
    match unit {
        "month" => Some(1),
        "quarter" => Some(3),
        "half_year" => Some(6),
        "year" => Some(12),
        _ => None,
    }
}

fn next_period_end(start: &str, unit: &str, interval: u64, day_of_month: u64) -> Result<String, String> {
    let start_date = time::OffsetDateTime::parse(start, &time::format_description::well_known::Rfc3339)
        .map_err(|_| "Invalid start date format")?;
    let interval = interval.max(1) as i32;
    match unit {
        "day" => {
            let end = start_date + time::Duration::days(interval as i64);
            Ok(end.format(&time::format_description::well_known::Rfc3339).unwrap_or_default())
        }
        "week" => {
            let end = start_date + time::Duration::weeks(interval as i64);
            Ok(end.format(&time::format_description::well_known::Rfc3339).unwrap_or_default())
        }
        "month" | "quarter" | "half_year" | "year" => {
            let months = months_per_unit(unit).ok_or("Invalid recurrence unit")? * interval;
            let mut year = start_date.year() as i32;
            let mut month = start_date.month() as i32 + months;
            while month > 12 { month -= 12; year += 1; }
            let day = if day_of_month > 0 { (day_of_month as u8).min(28) } else { start_date.day() };
            let month_u8 = (month as u8).min(12).max(1);
            let month_enum = time::Month::try_from(month_u8).map_err(|_| "Invalid month")?;
            let days_in_month = time::util::days_in_month(month_enum, year);
            let day = day.min(days_in_month);
            let end = time::Date::from_calendar_date(year, month_enum, day)
                .map_err(|_| "Invalid date calculation")?
                .with_hms_milli(start_date.hour(), start_date.minute(), start_date.second(), 0)
                .map_err(|_| "Invalid time")?
                .assume_utc();
            Ok(end.format(&time::format_description::well_known::Rfc3339).unwrap_or_default())
        }
        _ => Err("Invalid recurrence unit".into()),
    }
}

fn goal_from_request(req: &Value, id: &str, wallet_id: &str, existing: Option<&Value>) -> Result<Value, String> {
    let title = text(req, "title", 120)?;
    if title.is_empty() { return Err("Title is required".into()); }
    let goal_amount = req.get("goalAmount").and_then(Value::as_u64).filter(|v| *v > 0 && *v <= MAX_SATS).ok_or("Invalid goal amount")?;
    let target_date = text(req, "targetDate", 64)?;
    if target_date.is_empty() { return Err("Target date is required".into()); }
    let suggested = amounts(req)?;
    let stamp = now();

    let recurring = req.get("recurring").and_then(Value::as_bool).unwrap_or(false);
    let recurrence_unit = {
        let unit = req.get("recurrenceUnit").and_then(Value::as_str).unwrap_or("month");
        if !["day", "week", "month", "quarter", "half_year", "year"].contains(&unit) {
            return Err("Invalid recurrence unit".into());
        }
        unit.to_string()
    };
    let recurrence_interval = req.get("recurrenceInterval").and_then(Value::as_u64).filter(|v| *v >= 1 && *v <= 365).unwrap_or(1);
    let recurrence_day_of_month = req.get("recurrenceDayOfMonth").and_then(Value::as_u64).filter(|v| *v <= 31).unwrap_or(0);
    if recurrence_day_of_month > 0 && recurrence_unit != "month" {
        return Err("Day of month is only valid for monthly recurrence".into());
    }
    let target_wallet_id = text(req, "targetWalletId", 64)?;
    let rollover_mode = {
        let mode = req.get("rolloverMode").and_then(Value::as_str).unwrap_or("counts_as_progress");
        if !["counts_as_progress", "reset_to_zero"].contains(&mode) {
            return Err("Invalid rollover mode".into());
        }
        mode.to_string()
    };
    let sweep_mode = {
        let mode = req.get("sweepMode").and_then(Value::as_str).unwrap_or("target_amount");
        if !["target_amount", "entire_amount"].contains(&mode) {
            return Err("Invalid sweep mode".into());
        }
        mode.to_string()
    };

    let (period_index, period_start_date, period_end_date) = if recurring {
        if let Some(existing) = existing {
            let pi = existing.get("periodIndex").and_then(Value::as_u64).unwrap_or(0);
            let ps = existing.get("periodStartDate").and_then(Value::as_str).unwrap_or(&target_date);
            let pe = existing.get("periodEndDate").and_then(Value::as_str).unwrap_or(&target_date);
            (pi, ps.to_string(), pe.to_string())
        } else {
            (0u64, target_date.clone(), target_date.clone())
        }
    } else {
        (0u64, String::new(), String::new())
    };

    Ok(json!({
        "id": id, "walletId": wallet_id, "title": title,
        "descriptionAbove": text(req, "descriptionAbove", 2000)?,
        "descriptionBelow": text(req, "descriptionBelow", 2000)?,
        "goalAmount": goal_amount, "currentAmount": existing.and_then(|v| v.get("currentAmount")).and_then(Value::as_u64).unwrap_or(0),
        "targetDate": target_date, "suggestedAmounts": suggested,
        "walletMode": if req.get("walletMode").and_then(Value::as_str) == Some("all") { "all" } else { "vanilla" },
        "backgroundColor": color(req, "backgroundColor", "#FFFFFF")?, "textColor": color(req, "textColor", "#111111")?,
        "progressColor": color(req, "progressColor", "#2E7D32")?, "remainderColor": color(req, "remainderColor", "#E0E0E0")?,
        "fontName": text(req, "fontName", 64)?, "fontWeight": req.get("fontWeight").and_then(Value::as_u64).filter(|v| [400,600,700,800].contains(v)).unwrap_or(400),
        "nostrPubkey": text(req, "nostrPubkey", 64)?, "lightningAddressUsername": text(req, "lightningAddressUsername", 64)?,
        "createdAt": existing.and_then(|v| v.get("createdAt")).and_then(Value::as_str).unwrap_or(&stamp), "updatedAt": stamp,
        "recurring": recurring, "recurrenceUnit": recurrence_unit, "recurrenceInterval": recurrence_interval,
        "recurrenceDayOfMonth": recurrence_day_of_month, "targetWalletId": target_wallet_id,
        "rolloverMode": rollover_mode, "sweepMode": sweep_mode,
        "periodIndex": period_index, "periodStartDate": period_start_date, "periodEndDate": period_end_date
    }))
}
fn public_goal(goal: Value) -> Value {
    let amount = goal.get("goalAmount").and_then(Value::as_u64).unwrap_or(1);
    let current = goal.get("currentAmount").and_then(Value::as_u64).unwrap_or(0);
    let percent = ((current as f64 / amount as f64) * 100.0).min(100.0);
    let mut result = goal;
    result["percent"] = json!(percent);
    result["status"] = json!(if current >= amount { "complete" } else { "active" });
    result["lnurlPath"] = json!(format!("/api/v1/ext/zapgoalswasm/lnurl/{}", result["id"].as_str().unwrap_or("")));
    result
}
fn invoice_response(invoice: host::CreateInvoiceResponse) -> Value {
    json!({"paymentHash": invoice.payment_hash, "paymentRequest": invoice.payment_request, "checkingId": invoice.checking_id})
}
fn target_date_is_open(goal: &Value) -> bool {
    goal.get("targetDate").and_then(Value::as_str)
        .and_then(|value| time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok())
        .map(|target| target.unix_timestamp() > host::now().timestamp as i64)
        .unwrap_or(false)
}

struct Component;
impl Guest for Component {
    fn create_goal(payload: String) -> String {
        let req = match parse(&payload) { Ok(v) => v, Err(e) => return err(&e) };
        let wallet = match req.get("walletId").and_then(Value::as_str) { Some(v) if owns_wallet(v) => v, _ => return err("Wallet is not available to this user") };
        let goal_id = id();
        match goal_from_request(&req, &goal_id, wallet, None) { Ok(goal) if set("goals", &goal) => ok(goal), Ok(_) => err("Could not save goal"), Err(e) => err(&e) }
    }
    fn list_goals(_payload: String) -> String {
        let response = host::storage_get_paginated(&host::StoragePaginatedRequest { table: "goals".into(), filters_json: None, search: None, search_fields_json: None, sort_by: Some("updatedAt".into()), descending: true, limit: 100, offset: 0 });
        let rows: Value = serde_json::from_str(&response.rows_json).unwrap_or_else(|_| json!([]));
        ok(json!({"data": rows, "total": response.total}))
    }
    fn get_wallets(_payload: String) -> String {
        let items: Vec<Value> = host::list_user_wallets().wallets.into_iter().map(|wallet| json!({"id": wallet.id, "name": wallet.name})).collect();
        ok(json!({"data": items}))
    }
    fn update_goal(payload: String) -> String {
        let req = match parse(&payload) { Ok(v) => v, Err(e) => return err(&e) };
        let goal_id = match req.get("goalId").and_then(Value::as_str) { Some(v) => v, None => return err("Goal id is required") };
        let existing = match get("goals", goal_id, false) { Some(v) => v, None => return err("Goal not found") };
        let wallet = existing.get("walletId").and_then(Value::as_str).unwrap_or("");
        match goal_from_request(&req, goal_id, wallet, Some(&existing)) { Ok(goal) if set("goals", &goal) => ok(goal), Ok(_) => err("Could not save goal"), Err(e) => err(&e) }
    }
    fn delete_goal(payload: String) -> String {
        let req = match parse(&payload) { Ok(v) => v, Err(e) => return err(&e) };
        let goal_id = req.get("goalId").and_then(Value::as_str).unwrap_or("");
        if goal_id.is_empty() || !delete("goals", goal_id) { return err("Goal not found") }
        ok(json!({"deleted": true}))
    }
    fn get_public_goal(payload: String) -> String {
        let req = match parse(&payload) { Ok(v) => v, Err(e) => return err(&e) };
        let id = req.get("goalId").and_then(Value::as_str).unwrap_or("");
        match get("goals", id, true) { Some(goal) => ok(public_goal(goal)), None => err("Goal not found") }
    }
    fn create_invoice(payload: String) -> String {
        let req = match parse(&payload) { Ok(v) => v, Err(e) => return err(&e) };
        let id = req.get("goalId").and_then(Value::as_str).unwrap_or("");
        let goal = match get("goals", id, true) { Some(v) => v, None => return err("Goal not found") };
        if !target_date_is_open(&goal) { return err("This goal has ended") }
        let amount = req.get("amount").and_then(Value::as_u64).filter(|v| *v > 0 && *v <= MAX_SATS).unwrap_or(0);
        if amount == 0 { return err("Amount must be a positive satoshi amount") }
        let comment = req.get("comment").and_then(Value::as_str).unwrap_or("");
        if comment.len() > 280 { return err("Comment is too long") }
        let extra = json!({"goalId": id, "source": "invoice", "comment": comment});
        let invoice = host::create_invoice_public(&host::CreateInvoicePublicRequest { source_id: id.into(), amount, currency: "sat".into(), memo: format!("ZapGoals: {}", goal.get("title").and_then(Value::as_str).unwrap_or("Goal")), extra_json: Some(extra.to_string()) });
        ok(invoice_response(invoice))
    }
    fn lnurl_params(payload: String) -> String {
        let req = match parse(&payload) { Ok(value) => value, Err(message) => return lnurl_err(&message) };
        let id = req.get("goalId").and_then(Value::as_str).unwrap_or("");
        let goal = match get("goals", id, true) { Some(value) => value, None => return lnurl_err("Goal not found") };
        let title = goal.get("title").and_then(Value::as_str).unwrap_or("ZapGoals contribution");
        let metadata = json!([["text/plain", title], ["text/identifier", id]]).to_string();
        ok(json!({"tag":"payRequest","callback":format!("/api/v1/ext/zapgoalswasm/lnurl/callback/{}", id),"minSendable":1000,"maxSendable":MAX_SATS*1000,"metadata":metadata,"commentAllowed":280}))
    }
    fn lnurl_callback(payload: String) -> String {
        let req = match parse(&payload) { Ok(value) => value, Err(message) => return lnurl_err(&message) };
        let mut invoice_req = req.clone();
        let msat = req.get("amount").and_then(Value::as_u64).or_else(|| req.get("amount").and_then(Value::as_str).and_then(|value| value.parse::<u64>().ok())).unwrap_or(0);
        if msat < 1000 || msat > MAX_SATS * 1000 || msat % 1000 != 0 { return lnurl_err("Amount must be a whole number of sats between 1 and 2100000000") }
        invoice_req["amount"] = json!(msat / 1000);
        let result: Value = serde_json::from_str(&self::Component::create_invoice(invoice_req.to_string())).unwrap_or_else(|_| json!({"error":"Unable to create invoice"}));
        if let Some(pr) = result.get("paymentRequest").and_then(Value::as_str) { return ok(json!({"pr": pr, "routes": []})) }
        lnurl_err(result.get("error").and_then(Value::as_str).unwrap_or("Unable to create invoice"))
    }
    fn on_invoice_paid(payload: String) -> String {
        let event = match parse(&payload) { Ok(v) => v, Err(e) => return err(&e) };
        if event.get("pending").and_then(Value::as_bool) == Some(true) { return ok(json!({"ignored": true})) }
        let status = event.get("status").and_then(Value::as_str).unwrap_or("");
        if !status.is_empty() && !matches!(status, "success" | "settled" | "paid") { return ok(json!({"ignored": true})) }
        let payment = event.get("payment").unwrap_or(&Value::Null);
        let extra = event.get("extra").or_else(|| payment.get("extra")).or_else(|| payment.get("extraJson")).and_then(Value::as_object);
        let extension_extra = extra.and_then(|value| value.get("extra_zapgoalswasm")).and_then(Value::as_object);
        let goal_id = extra.and_then(|value| value.get("source_id")).and_then(Value::as_str)
            .or_else(|| extra.and_then(|value| value.get("goalId")).and_then(Value::as_str))
            .or_else(|| extension_extra.and_then(|value| value.get("goalId")).and_then(Value::as_str)).unwrap_or("");
        let payment_hash = event.get("paymentHash").and_then(Value::as_str).unwrap_or("");
        if goal_id.is_empty() || payment_hash.is_empty() { return ok(json!({"ignored": true})) }
        let mut goal = match get("goals", goal_id, false) { Some(value) => value, None => return err("Goal not found") };
        if let Some(processed) = get("payment_events", payment_hash, false) {
            let recorded_total = processed.get("newTotal").and_then(Value::as_u64).unwrap_or(0);
            let current = goal.get("currentAmount").and_then(Value::as_u64).unwrap_or(0);
            if recorded_total > current {
                goal["currentAmount"] = json!(recorded_total);
                goal["updatedAt"] = json!(now());
                if !set("goals", &goal) { return err("Could not finish payment recovery") }
            }
            return ok(json!({"duplicate": true, "goalId": goal_id}));
        }
        let amount_msat = event.get("amount").and_then(Value::as_u64).or_else(|| payment.get("amount").and_then(Value::as_u64)).unwrap_or(0);
        if amount_msat == 0 || amount_msat % 1000 != 0 { return err("Paid invoice amount is invalid") }
        let amount_sat = amount_msat / 1000;
        if amount_sat > MAX_SATS { return err("Paid invoice amount exceeds the limit") }
        let current = goal.get("currentAmount").and_then(Value::as_u64).unwrap_or(0);
        let new_total = current.saturating_add(amount_sat);
        let payment_event = json!({"id": payment_hash, "goalId": goal_id, "amount": amount_sat, "newTotal": new_total, "processedAt": now()});
        if !set("payment_events", &payment_event) { return err("Could not record payment") }
        goal["currentAmount"] = json!(new_total);
        goal["updatedAt"] = json!(now());
        if !set("goals", &goal) { return err("Could not update goal") }
        ok(json!({"updated": true, "goalId": goal_id, "amount": amount_sat}))
    }
    fn sweep_goal(payload: String) -> String {
        let req = match parse(&payload) { Ok(v) => v, Err(e) => return err(&e) };
        let goal_id = req.get("goalId").and_then(Value::as_str).unwrap_or("");
        if goal_id.is_empty() { return err("Goal id is required") }
        let mut goal = match get("goals", goal_id, false) { Some(v) => v, None => return err("Goal not found") };
        let recurring = goal.get("recurring").and_then(Value::as_bool).unwrap_or(false);
        if !recurring { return err("Goal is not recurring") }

        let current_amount = goal.get("currentAmount").and_then(Value::as_u64).unwrap_or(0);
        let goal_amount = goal.get("goalAmount").and_then(Value::as_u64).unwrap_or(0);
        let sweep_mode = goal.get("sweepMode").and_then(Value::as_str).unwrap_or("target_amount");
        let rollover_mode = goal.get("rolloverMode").and_then(Value::as_str).unwrap_or("counts_as_progress");

        let moved_amount = if sweep_mode == "entire_amount" {
            current_amount
        } else {
            current_amount.min(goal_amount)
        };
        let rollover_amount = if sweep_mode == "target_amount" && current_amount > goal_amount {
            current_amount - goal_amount
        } else {
            0
        };

        let period_index = goal.get("periodIndex").and_then(Value::as_u64).unwrap_or(0);
        let period_start = goal.get("periodStartDate").and_then(Value::as_str).unwrap_or("").to_string();
        let period_end = goal.get("periodEndDate").and_then(Value::as_str).unwrap_or("").to_string();

        let period_id = id();
        let period = json!({
            "id": period_id, "goalId": goal_id, "periodIndex": period_index,
            "startDate": period_start, "endDate": period_end,
            "zappedAmount": current_amount, "movedAmount": moved_amount,
            "rolloverAmount": rollover_amount, "sweepMode": sweep_mode,
            "completedAt": now()
        });
        if !set("periods", &period) { return err("Could not record period") }

        let unit = goal.get("recurrenceUnit").and_then(Value::as_str).unwrap_or("month");
        let interval = goal.get("recurrenceInterval").and_then(Value::as_u64).unwrap_or(1);
        let day_of_month = goal.get("recurrenceDayOfMonth").and_then(Value::as_u64).unwrap_or(0);

        let new_period_end = match next_period_end(&period_end, unit, interval, day_of_month) {
            Ok(date) => date,
            Err(e) => return err(&e),
        };

        let new_current = if rollover_mode == "counts_as_progress" {
            rollover_amount
        } else {
            0
        };

        goal["periodIndex"] = json!(period_index + 1);
        goal["periodStartDate"] = json!(period_end);
        goal["periodEndDate"] = json!(new_period_end);
        goal["targetDate"] = json!(new_period_end);
        goal["currentAmount"] = json!(new_current);
        goal["updatedAt"] = json!(now());

        if !set("goals", &goal) { return err("Could not advance goal period") }

        ok(json!({
            "goalId": goal_id, "periodId": period_id, "movedAmount": moved_amount,
            "rolloverAmount": rollover_amount, "newPeriodIndex": period_index + 1,
            "newPeriodEnd": new_period_end, "newCurrentAmount": new_current
        }))
    }
    fn list_periods(payload: String) -> String {
        let req = match parse(&payload) { Ok(v) => v, Err(e) => return err(&e) };
        let goal_id = req.get("goalId").and_then(Value::as_str).unwrap_or("");
        if goal_id.is_empty() { return err("Goal id is required") }
        let filters = json!({"goalId": goal_id}).to_string();
        let response = host::storage_get_paginated(&host::StoragePaginatedRequest {
            table: "periods".into(),
            filters_json: Some(filters),
            search: None,
            search_fields_json: None,
            sort_by: Some("periodIndex".into()),
            descending: true,
            limit: 100,
            offset: 0,
        });
        let rows: Value = serde_json::from_str(&response.rows_json).unwrap_or_else(|_| json!([]));
        ok(json!({"data": rows, "total": response.total}))
    }
}
export!(Component);
