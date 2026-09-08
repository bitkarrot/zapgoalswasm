//! Test-only, synchronous in-memory implementation of the actual host surface.
//! All IDs/invoices are synthetic; nothing here accesses the network or LNbits.
#![allow(dead_code)]
use crate::tests::Guest;
use serde_json::{json, Value};
use std::{cell::RefCell, collections::BTreeMap};

pub const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub const WALLET: &str = "private-goal-wallet";

#[derive(Clone)]
pub struct StorageGetRequest {
    pub table: String,
    pub id: String,
}
pub struct StorageGetPublicRequest {
    pub table: String,
    pub id: String,
}
pub struct StorageGetResponse {
    pub data_json: Option<String>,
}
pub struct StorageSetRequest {
    pub table: String,
    pub data_json: Option<String>,
}
pub struct StorageSetResponse {
    pub ok: bool,
}
pub struct StorageAppendPublicRequest {
    pub table: String,
    pub source_id: String,
    pub data_json: Option<String>,
}
pub struct StorageAppendPublicResponse {
    pub id: String,
}
pub struct StorageDeleteRequest {
    pub table: String,
    pub id: String,
}
pub struct StorageDeleteResponse {
    pub ok: bool,
}
pub struct StoragePaginatedRequest {
    pub table: String,
    pub filters_json: Option<String>,
    pub search: Option<String>,
    pub search_fields_json: Option<String>,
    pub sort_by: Option<String>,
    pub descending: bool,
    pub limit: u32,
    pub offset: u32,
}
pub struct StoragePublicPaginatedRequest {
    pub table: String,
    pub source_id: String,
    pub filters_json: Option<String>,
    pub search: Option<String>,
    pub search_fields_json: Option<String>,
    pub sort_by: Option<String>,
    pub descending: bool,
    pub limit: u32,
    pub offset: u32,
}
pub struct StoragePaginatedResponse {
    pub rows_json: String,
    pub total: u32,
}
#[derive(Clone)]
pub struct CreateInvoicePublicRequest {
    pub source_id: String,
    pub amount: u64,
    pub currency: String,
    pub memo: String,
    pub extra: Vec<(String, String)>,
}
pub struct CreateInvoiceResponse {
    pub payment_hash: String,
    pub payment_request: String,
    pub checking_id: String,
}
pub struct WalletSummary {
    pub id: String,
    pub name: String,
    pub currency: Option<String>,
}
pub struct ListWalletsResponse {
    pub wallets: Vec<WalletSummary>,
}
pub struct NowResponse {
    pub timestamp: u64,
}
pub struct RandomIdRequest {
    pub prefix: String,
}
pub struct RandomIdResponse {
    pub id: String,
}
pub struct LogRequest {
    pub level: String,
    pub message: String,
}
pub struct LogResponse {
    pub ok: bool,
}

#[derive(Default)]
pub struct State {
    pub rows: BTreeMap<(String, String), Value>,
    pub calls: Vec<String>,
    pub reads: Vec<(String, String, bool)>,
    pub writes: Vec<(String, Value)>,
    pub invoices: Vec<CreateInvoicePublicRequest>,
    pub logs: Vec<String>,
    pub timestamp: u64,
    pub seq: u64,
    pub fail_write_once: Option<String>,
    pub deny_append: bool,
    pub empty_append_id: bool,
    pub fail_invoice: bool,
    pub settle_during_create: bool,
    pub early_result: Option<Value>,
    pub append_limit: usize,
    pub pagination_calls: usize,
    pub churn_reads: usize,
    pub duplicate_page: bool,
    pub archive_before_goal_set: bool,
}
thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }
pub fn state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    STATE.with(|s| f(&mut s.borrow_mut()))
}
pub fn reset() {
    state(|s| {
        *s = State {
            timestamp: 1_767_225_600,
            append_limit: 10_000,
            ..State::default()
        }
    });
}
pub fn seed(table: &str, row: Value) {
    let id = row["id"].as_str().expect("seed row id").to_string();
    state(|s| {
        s.rows.insert((table.into(), id), row);
    });
}
pub fn row(table: &str, id: &str) -> Option<Value> {
    state(|s| s.rows.get(&(table.into(), id.into())).cloned())
}
pub fn storage_get(req: &StorageGetRequest) -> StorageGetResponse {
    state(|s| s.reads.push((req.table.clone(), req.id.clone(), false)));
    StorageGetResponse {
        data_json: row(&req.table, &req.id).map(|v| v.to_string()),
    }
}
pub fn storage_get_public(req: &StorageGetPublicRequest) -> StorageGetResponse {
    state(|s| s.reads.push((req.table.clone(), req.id.clone(), true)));
    let fields: &[&str] = match req.table.as_str() {
        "goals" => &[
            "id",
            "title",
            "descriptionAbove",
            "descriptionBelow",
            "goalAmount",
            "currentAmount",
            "targetDate",
            "suggestedAmounts",
            "walletMode",
            "backgroundColor",
            "textColor",
            "progressColor",
            "remainderColor",
            "fontName",
            "fontWeight",
            "createdAt",
            "updatedAt",
            "recurring",
            "recurrenceUnit",
            "recurrenceInterval",
            "periodIndex",
            "periodEndDate",
            "periodStartDate",
            "recurrenceDayOfMonth",
            "sweepMode",
            "rolloverMode",
            "accountingVersion",
            "archived",
        ],
        "payment_events" => &["id", "goalId", "verified", "amount", "issuedAt"],
        _ => panic!("No public-read policy for {}", req.table),
    };
    let data = row(&req.table, &req.id).map(|mut v| {
        v.as_object_mut()
            .unwrap()
            .retain(|k, _| fields.contains(&k.as_str()));
        v.to_string()
    });
    StorageGetResponse { data_json: data }
}
pub fn storage_set(req: &StorageSetRequest) -> StorageSetResponse {
    let value: Value = serde_json::from_str(req.data_json.as_ref().unwrap()).unwrap();
    let archive = state(|s| {
        if req.table == "goals" && s.archive_before_goal_set {
            s.archive_before_goal_set = false;
            true
        } else {
            false
        }
    });
    if archive {
        // Pause this edit after its stale read, commit archive, then resume.
        let archived: Value = serde_json::from_str(&crate::Component::delete_goal(
            json!({"goalId":value["id"]}).to_string(),
        ))
        .unwrap();
        assert_eq!(archived["archived"], true);
    }
    let fail = state(|s| {
        s.calls.push(format!("set:{}", req.table));
        if s.fail_write_once.as_ref() == Some(&req.table) {
            s.fail_write_once = None;
            true
        } else {
            s.writes.push((req.table.clone(), value.clone()));
            false
        }
    });
    if !fail {
        // Match stock ON CONFLICT: only supplied columns are updated.
        let id = value["id"].as_str().unwrap();
        let mut stored = row(&req.table, id).unwrap_or(json!({}));
        stored
            .as_object_mut()
            .unwrap()
            .extend(value.as_object().unwrap().clone());
        seed(&req.table, stored);
    }
    StorageSetResponse { ok: !fail }
}
pub fn storage_append_public(req: &StorageAppendPublicRequest) -> StorageAppendPublicResponse {
    assert_eq!(req.table, "invoice_issuances");
    assert!(
        row("goals", &req.source_id).is_some(),
        "source owner must exist"
    );
    let mut value: Value = serde_json::from_str(req.data_json.as_ref().unwrap()).unwrap();
    assert!(value
        .as_object()
        .unwrap()
        .keys()
        .all(|k| ["amount", "createdAt"].contains(&k.as_str())));
    let id = state(|s| {
        s.calls.push("append:invoice_issuances".into());
        assert!(!s.deny_append, "append permission denied");
        let count = s
            .rows
            .iter()
            .filter(|((table, _), row)| {
                table == "invoice_issuances" && row["goalId"] == req.source_id
            })
            .count();
        assert!(count < s.append_limit, "append row cap exceeded");
        if s.empty_append_id {
            return String::new();
        }
        s.seq += 1;
        format!("{:032x}", s.seq)
    });
    if !id.is_empty() {
        value["id"] = json!(id);
        value["goalId"] = json!(req.source_id); // Host policy forces this field.
        seed("invoice_issuances", value);
    }
    StorageAppendPublicResponse { id }
}
pub fn storage_delete(req: &StorageDeleteRequest) -> StorageDeleteResponse {
    StorageDeleteResponse {
        ok: state(|s| {
            s.rows
                .remove(&(req.table.clone(), req.id.clone()))
                .is_some()
        }),
    }
}
pub fn storage_get_paginated(req: &StoragePaginatedRequest) -> StoragePaginatedResponse {
    let filters: Value = req
        .filters_json
        .as_ref()
        .map(|s| serde_json::from_str(s).unwrap())
        .unwrap_or(json!({}));
    let rows: Vec<Value> = state(|s| {
        s.rows
            .iter()
            .filter(|((t, _), v)| {
                t == &req.table
                    && filters
                        .as_object()
                        .unwrap()
                        .iter()
                        .all(|(k, expected)| v.get(k) == Some(expected))
            })
            .map(|(_, v)| v.clone())
            .collect()
    });
    let mut total = rows.len() as u32;
    state(|s| {
        s.pagination_calls += 1;
        if s.churn_reads > 0 {
            total += s.pagination_calls as u32;
            s.churn_reads -= 1;
        }
    });
    let rows: Vec<_> = if state(|s| s.duplicate_page) {
        rows.into_iter().take(req.limit as usize).collect()
    } else {
        rows.into_iter()
            .skip(req.offset as usize)
            .take(req.limit as usize)
            .collect()
    };
    StoragePaginatedResponse {
        rows_json: json!(rows).to_string(),
        total,
    }
}
pub fn storage_get_public_paginated(
    req: &StoragePublicPaginatedRequest,
) -> StoragePaginatedResponse {
    assert_eq!(req.table, "payment_events");
    assert_eq!(req.sort_by.as_deref(), Some("id"));
    let mut filters: Value = req
        .filters_json
        .as_ref()
        .map(|s| serde_json::from_str(s).unwrap())
        .unwrap_or(json!({}));
    if let Some(id) = filters.get("goalId") {
        assert_eq!(id, &json!(req.source_id));
    }
    filters["goalId"] = json!(req.source_id);
    let mut page = storage_get_paginated(&StoragePaginatedRequest {
        table: req.table.clone(),
        filters_json: Some(filters.to_string()),
        search: None,
        search_fields_json: None,
        sort_by: req.sort_by.clone(),
        descending: req.descending,
        limit: req.limit,
        offset: req.offset,
    });
    let mut rows: Vec<Value> = serde_json::from_str(&page.rows_json).unwrap();
    for row in &mut rows {
        row.as_object_mut().unwrap().retain(|k, _| {
            ["id", "goalId", "verified", "amount", "issuedAt"].contains(&k.as_str())
        });
    }
    page.rows_json = json!(rows).to_string();
    page
}
pub fn event(extra: Value) -> Value {
    json!({"walletId": WALLET, "pending": false, "status": "success", "paymentHash": HASH,
        "amount": extra["amount"].as_u64().or_else(|| extra["amount"].as_str().and_then(|v| v.parse::<u64>().ok())).unwrap() * 1000,
        "extra": {"source_id": extra["goalId"], "extra_zapgoalswasm": extra}})
}
pub fn last_event() -> Value {
    let extra = state(|s| native_extra(&s.invoices.last().unwrap().extra));
    event(extra)
}
pub fn native_extra(pairs: &[(String, String)]) -> Value {
    Value::Object(
        pairs
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    )
}
pub fn create_invoice_public(req: &CreateInvoicePublicRequest) -> CreateInvoiceResponse {
    // Match stock Pydantic native extra dict coercion; never invent a JSON alias.
    let extra = native_extra(&req.extra);
    assert_eq!(extra["amount"], req.amount.to_string());
    let issue_id = extra["issueId"].as_str().expect("private issuance secret");
    let issuance = row("invoice_issuances", issue_id).expect("issuance must already be durable");
    assert_eq!(issuance["goalId"], req.source_id);
    assert_eq!(issuance["amount"], req.amount);
    assert_eq!(req.currency, "sat");
    assert!(
        !req.memo.contains(issue_id),
        "private binding must not enter BOLT11 memo"
    );
    let settle = state(|s| {
        s.calls.push("create_invoice_public".into());
        s.invoices.push(req.clone());
        assert!(!s.fail_invoice, "synthetic invoice host failure");
        s.settle_during_create
    });
    if settle {
        let result: Value =
            serde_json::from_str(&crate::Component::on_invoice_paid(event(extra).to_string()))
                .unwrap();
        state(|s| s.early_result = Some(result));
    }
    CreateInvoiceResponse {
        payment_hash: HASH.into(),
        payment_request: "lnbc-synthetic-never-pay".into(),
        checking_id: "mock-checking-id".into(),
    }
}
pub fn list_user_wallets() -> ListWalletsResponse {
    ListWalletsResponse {
        wallets: vec![WalletSummary {
            id: WALLET.into(),
            name: "Mock wallet".into(),
            currency: None,
        }],
    }
}
pub fn now() -> NowResponse {
    NowResponse {
        timestamp: state(|s| s.timestamp),
    }
}
pub fn random_id(req: &RandomIdRequest) -> RandomIdResponse {
    RandomIdResponse {
        id: state(|s| {
            s.seq += 1;
            format!("{}{}", req.prefix, s.seq)
        }),
    }
}
pub fn log(req: &LogRequest) -> LogResponse {
    state(|s| s.logs.push(format!("{}:{}", req.level, req.message)));
    LogResponse { ok: true }
}
