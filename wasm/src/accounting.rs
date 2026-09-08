//! Pure fixed-calendar accounting. Stored goals contain an immutable opening
//! balance/rules; receipts are immutable and assigned by verified issuance time.
//! Never persist `Projection::goal` back over the stored accounting inputs.
//!
//! Callers must supply a complete, stable, goal-scoped receipt set. This module
//! performs no storage, clocks, invoice creation, mutations, or host calls.

use serde_json::{json, Value};
use std::collections::{BTreeSet, VecDeque};
use time::{format_description::well_known::Rfc3339, OffsetDateTime, UtcOffset};

/// Maximum periods examined, including the active period. Never truncate a sum.
pub const MAX_PERIODS: u64 = 10_000;
pub const HISTORY_LIMIT: usize = 100;

#[derive(Debug, Clone)]
pub struct Projection {
    /// Presentation copy with current amount and active calendar fields derived.
    /// The original stored `currentAmount` remains the opening balance.
    pub goal: Value,
    /// Latest 100 closed periods, newest first. Amounts may change on late payment.
    pub history: Vec<Value>,
    /// Lifetime accounting from the preserved opening balance, not older history.
    /// totalAmount == movedAmount + retainedAmount + currentAmount.
    pub totals: Value,
}

fn invalid(field: &str) -> String {
    format!("Invalid accounting {field}")
}

fn unsigned(value: &Value, field: &str) -> Result<u64, String> {
    value.as_u64().ok_or_else(|| invalid(field))
}

fn integer_or(goal: &Value, field: &str, default: u64) -> Result<u64, String> {
    match goal.get(field) {
        None => Ok(default),
        Some(value) => unsigned(value, field),
    }
}

fn checked_add(a: u64, b: u64) -> Result<u64, String> {
    a.checked_add(b)
        .ok_or_else(|| "Accounting amount overflow".to_string())
}

fn unix_date(timestamp: u64) -> Result<OffsetDateTime, String> {
    let timestamp = i64::try_from(timestamp)
        .map_err(|_| "Accounting timestamp is outside the supported range".to_string())?;
    OffsetDateTime::from_unix_timestamp(timestamp)
        .map_err(|_| "Accounting timestamp is outside the supported range".to_string())
}

fn datetime(value: &Value) -> Result<OffsetDateTime, String> {
    if let Some(timestamp) = value.as_u64() {
        return unix_date(timestamp);
    }
    let raw = value
        .as_str()
        .ok_or_else(|| "Invalid accounting timestamp".to_string())?
        .trim();
    if let Ok(timestamp) = raw.parse::<u64>() {
        return unix_date(timestamp);
    }
    let date = OffsetDateTime::parse(raw, &Rfc3339)
        .map_err(|_| "Invalid accounting timestamp: expected Unix seconds or RFC3339".to_string())?
        .checked_to_offset(UtcOffset::UTC)
        .ok_or_else(|| "Accounting timestamp is outside the supported range".to_string())?;
    if date.unix_timestamp() < 0 {
        return Err("Accounting timestamp must not precede the Unix epoch".into());
    }
    Ok(date)
}

/// Parse Unix seconds (number or numeric string) or an RFC3339 timestamp.
/// Reject nonzero subseconds rather than silently changing a boundary when
/// callers persist the returned integer. `project` itself compares RFC3339
/// dates at full precision, including subseconds.
pub fn parse_timestamp(value: &Value) -> Result<u64, String> {
    let date = datetime(value)?;
    if date.nanosecond() != 0 {
        return Err("Accounting timestamp must use whole seconds".into());
    }
    u64::try_from(date.unix_timestamp()).map_err(|_| invalid("timestamp"))
}

fn format_date(date: OffsetDateTime) -> Result<String, String> {
    date.format(&Rfc3339)
        .map_err(|_| "Accounting date is outside the RFC3339 range".to_string())
}

/// Normalize an RFC3339 date to UTC, preserving any fractional seconds.
pub fn normalize_date(value: &str) -> Result<String, String> {
    let date = OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| "Invalid RFC3339 accounting date".to_string())?
        .checked_to_offset(UtcOffset::UTC)
        .ok_or_else(|| "Accounting date is outside the supported range".to_string())?;
    if date.unix_timestamp() < 0 {
        return Err("Accounting date must not precede the Unix epoch".into());
    }
    format_date(date)
}

#[derive(Clone, Copy)]
enum Unit {
    Days(u64),
    Months(u64),
}

#[derive(Clone, Copy)]
struct Schedule {
    first_end: OffsetDateTime,
    interval: u64,
    unit: Unit,
    anchor_day: u8,
}

impl Schedule {
    fn new(
        first_end: OffsetDateTime,
        unit: &str,
        interval: u64,
        day_of_month: u64,
    ) -> Result<Self, String> {
        if !(1..=365).contains(&interval) {
            return Err("Invalid recurrence interval: expected 1 through 365".into());
        }
        if day_of_month > 31 || (day_of_month > 0 && unit != "month") {
            return Err("Invalid recurrence day of month".into());
        }
        let unit = match unit {
            "day" => Unit::Days(1),
            "week" => Unit::Days(7),
            "month" => Unit::Months(1),
            "quarter" => Unit::Months(3),
            "half_year" => Unit::Months(6),
            "year" => Unit::Months(12),
            _ => return Err("Invalid recurrence unit".into()),
        };
        Ok(Self {
            first_end,
            interval,
            unit,
            anchor_day: if day_of_month == 0 {
                first_end.day()
            } else {
                day_of_month as u8
            },
        })
    }

    /// Every boundary is calculated from the immutable first end, never from
    /// a previously clamped month. Jan 31 -> Feb 28 -> Mar 31, not Mar 28.
    fn boundary(self, step: u64) -> Result<OffsetDateTime, String> {
        if step == 0 {
            return Ok(self.first_end);
        }
        let overflow = || "Accounting calendar calculation overflow".to_string();
        let steps = self.interval.checked_mul(step).ok_or_else(overflow)?;
        match self.unit {
            Unit::Days(days) => {
                let seconds = steps
                    .checked_mul(days)
                    .and_then(|days| days.checked_mul(86_400))
                    .and_then(|seconds| i64::try_from(seconds).ok())
                    .ok_or_else(overflow)?;
                self.first_end
                    .checked_add(time::Duration::seconds(seconds))
                    .ok_or_else(overflow)
            }
            Unit::Months(months) => {
                let months = steps
                    .checked_mul(months)
                    .and_then(|months| i64::try_from(months).ok())
                    .ok_or_else(overflow)?;
                let first_month = i64::from(self.first_end.year()) * 12
                    + i64::from(self.first_end.month() as u8)
                    - 1;
                let index = first_month.checked_add(months).ok_or_else(overflow)?;
                let year = i32::try_from(index.div_euclid(12)).map_err(|_| overflow())?;
                let month = time::Month::try_from((index.rem_euclid(12) + 1) as u8)
                    .map_err(|_| overflow())?;
                let day = self.anchor_day.min(time::util::days_in_month(month, year));
                let date = time::Date::from_calendar_date(year, month, day).map_err(|_| {
                    "Accounting calendar is outside the supported range".to_string()
                })?;
                Ok(date.with_time(self.first_end.time()).assume_utc())
            }
        }
    }
}

/// Calendar helper: `step == 0` is `first_end`; subsequent boundaries remain
/// anchored to it. Explicit day-of-month is permitted only for monthly rules.
pub fn calendar_boundary(
    first_end: &str,
    unit: &str,
    interval: u64,
    day_of_month: u64,
    step: u64,
) -> Result<String, String> {
    let first_end = datetime(&Value::String(normalize_date(first_end)?))?;
    format_date(Schedule::new(first_end, unit, interval, day_of_month)?.boundary(step)?)
}

struct Receipt {
    issued_at: OffsetDateTime,
    amount: u64,
}

fn receipts_for_goal(
    goal_id: &str,
    receipts: &[Value],
    as_of: OffsetDateTime,
) -> Result<(Vec<Receipt>, u64), String> {
    let mut verified = Vec::new();
    let mut ids = BTreeSet::new();
    let mut total = 0;
    for receipt in receipts {
        // Legacy/unverified rows never contribute, even if their old fields
        // are malformed. Their hashes remain caller-maintained tombstones.
        if receipt.get("verified").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        if receipt.get("goalId").and_then(Value::as_str) != Some(goal_id) {
            return Err("Verified receipt belongs to another goal".into());
        }
        // The listing layer guarantees unique hashes. Also reject duplicates
        // defensively when IDs are present; public projections need not expose
        // private hashes, so IDs are not required by this pure function.
        if let Some(id) = receipt.get("id") {
            let id = id
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| invalid("receipt id"))?;
            if !ids.insert(id) {
                return Err("Duplicate verified receipt id".into());
            }
        }
        let amount = unsigned(
            receipt.get("amount").unwrap_or(&Value::Null),
            "receipt amount",
        )?;
        if amount == 0 {
            return Err("Verified receipt amount must be positive".into());
        }
        let issued_at = datetime(receipt.get("issuedAt").unwrap_or(&Value::Null))?;
        if issued_at > as_of {
            return Err("Verified receipt issuance is after as_of; clock inconsistency, retry with a current timestamp".into());
        }
        total = checked_add(total, amount)?;
        verified.push(Receipt { issued_at, amount });
    }
    verified.sort_unstable_by_key(|receipt| receipt.issued_at);
    Ok((verified, total))
}

fn totals(
    opening: u64,
    received: u64,
    moved: u64,
    retained: u64,
    current: u64,
    count: usize,
    closed: u64,
) -> Result<Value, String> {
    let total = checked_add(opening, received)?;
    if checked_add(checked_add(moved, retained)?, current)? != total {
        return Err("Accounting conservation invariant failed".into());
    }
    Ok(json!({
        "openingAmount": opening,
        "receiptAmount": received,
        "totalAmount": total,
        "movedAmount": moved,
        "retainedAmount": retained,
        "currentAmount": current,
        "verifiedReceiptCount": count,
        "closedPeriods": closed,
        "accountingOnly": true
    }))
}

/// Derive a consistent view from immutable inputs. `as_of` is Unix seconds;
/// issuance exactly at a boundary belongs to the following period. Issuances
/// before the first start are attributed to the first represented period.
/// A future issuance (including clock rollback) is an explicit error, not a
/// silently excluded payment. Replays require no recovery or mutable totals.
///
/// For legacy goals, `currentAmount` is the preserved opening balance and
/// `periodIndex` the first represented index. Earlier history is not recomputed.
/// Stored period end falls back to targetDate when invalid; start falls back to
/// createdAt unless the stored start is valid and strictly before the first end.
pub fn project(goal: &Value, receipts: &[Value], as_of: u64) -> Result<Projection, String> {
    if !goal.is_object() {
        return Err("Accounting goal must be an object".into());
    }
    let goal_id = goal
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| invalid("goal id"))?;
    let as_of = unix_date(as_of)?;
    let opening = integer_or(goal, "currentAmount", 0)?;
    let (payments, received) = receipts_for_goal(goal_id, receipts, as_of)?;
    let total = checked_add(opening, received)?;
    let recurring = match goal.get("recurring") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(_) => return Err(invalid("recurring flag")),
    };
    let mut projected_goal = goal.clone();
    if !recurring {
        projected_goal["currentAmount"] = json!(total);
        return Ok(Projection {
            goal: projected_goal,
            history: Vec::new(),
            totals: totals(opening, received, 0, 0, total, payments.len(), 0)?,
        });
    }

    let target = unsigned(
        goal.get("goalAmount").unwrap_or(&Value::Null),
        "goal amount",
    )?;
    if target == 0 {
        return Err("Recurring goal amount must be positive".into());
    }
    let first_index = integer_or(goal, "periodIndex", 0)?;
    let first_end = goal
        .get("periodEndDate")
        .and_then(|date| datetime(date).ok())
        .or_else(|| goal.get("targetDate").and_then(|date| datetime(date).ok()))
        .ok_or_else(|| {
            "Recurring goal needs a valid first period end or target date".to_string()
        })?;
    let first_start = goal
        .get("periodStartDate")
        .and_then(|date| datetime(date).ok())
        .filter(|date| *date < first_end)
        .or_else(|| goal.get("createdAt").and_then(|date| datetime(date).ok()))
        .ok_or_else(|| {
            "Recurring goal needs a valid period start or creation timestamp".to_string()
        })?;
    if first_start >= first_end {
        return Err("Recurring first period start must be before its end".into());
    }
    if as_of < first_start {
        return Err("as_of precedes the accounting start; clock inconsistency".into());
    }
    let unit = match goal.get("recurrenceUnit") {
        None => "month",
        Some(value) => value.as_str().ok_or_else(|| invalid("recurrence unit"))?,
    };
    let schedule = Schedule::new(
        first_end,
        unit,
        integer_or(goal, "recurrenceInterval", 1)?,
        integer_or(goal, "recurrenceDayOfMonth", 0)?,
    )?;
    let sweep_mode = match goal.get("sweepMode") {
        None => "target_amount",
        Some(value) => value.as_str().ok_or_else(|| invalid("sweep mode"))?,
    };
    if !["target_amount", "entire_amount"].contains(&sweep_mode) {
        return Err(invalid("sweep mode"));
    }
    let rollover_mode = match goal.get("rolloverMode") {
        None => "counts_as_progress",
        Some(value) => value.as_str().ok_or_else(|| invalid("rollover mode"))?,
    };
    if !["counts_as_progress", "reset_to_zero"].contains(&rollover_mode) {
        return Err(invalid("rollover mode"));
    }

    let mut history = VecDeque::with_capacity(HISTORY_LIMIT);
    let mut carry = opening;
    let mut moved_total = 0;
    let mut retained_total = 0;
    let mut start = first_start;
    let mut payment_index = 0;
    for offset in 0..MAX_PERIODS {
        let index = first_index
            .checked_add(offset)
            .ok_or_else(|| "Accounting period index overflow".to_string())?;
        let end = schedule.boundary(offset)?;
        if end <= start {
            return Err("Accounting calendar boundaries must increase".into());
        }
        let mut period_received = 0;
        while let Some(payment) = payments.get(payment_index) {
            if payment.issued_at >= end {
                break;
            }
            period_received = checked_add(period_received, payment.amount)?;
            payment_index += 1;
        }
        let available = checked_add(carry, period_received)?;
        if as_of < end {
            if payment_index != payments.len() {
                return Err("Accounting receipt allocation is incomplete".into());
            }
            projected_goal["currentAmount"] = json!(available);
            projected_goal["targetDate"] = json!(format_date(end)?);
            projected_goal["periodIndex"] = json!(index);
            projected_goal["periodStartDate"] = json!(format_date(start)?);
            projected_goal["periodEndDate"] = json!(format_date(end)?);
            return Ok(Projection {
                goal: projected_goal,
                history: history.into_iter().rev().collect(),
                totals: totals(
                    opening,
                    received,
                    moved_total,
                    retained_total,
                    available,
                    payments.len(),
                    offset,
                )?,
            });
        }
        let moved = if sweep_mode == "entire_amount" {
            available
        } else {
            available.min(target)
        };
        let excess = available
            .checked_sub(moved)
            .ok_or_else(|| invalid("allocation"))?;
        let next_carry = if rollover_mode == "counts_as_progress" {
            excess
        } else {
            0
        };
        let retained = excess
            .checked_sub(next_carry)
            .ok_or_else(|| invalid("carry"))?;
        moved_total = checked_add(moved_total, moved)?;
        retained_total = checked_add(retained_total, retained)?;
        if history.len() == HISTORY_LIMIT {
            history.pop_front();
        }
        history.push_back(json!({
            "id": format!("{goal_id}:{index}"),
            "goalId": goal_id,
            "periodIndex": index,
            "startDate": format_date(start)?,
            "endDate": format_date(end)?,
            "openingAmount": carry,
            "receivedAmount": period_received,
            "zappedAmount": available,
            "movedAmount": moved,
            "rolloverAmount": next_carry,
            "retainedAmount": retained,
            "sweepMode": sweep_mode,
            "rolloverMode": rollover_mode,
            "completedAt": format_date(end)?,
            "accountingOnly": true,
            "latePaymentsMayRevise": true
        }));
        carry = next_carry;
        start = end;
    }
    Err(format!("Accounting projection exceeds the {MAX_PERIODS}-period limit (including the active period); explicit archival or reconciliation is required"))
}
