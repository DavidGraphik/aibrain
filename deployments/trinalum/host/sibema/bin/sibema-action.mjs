#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { SibemaClient } from "../lib/sibema-client.mjs";
import { SibemaStore } from "../lib/store.mjs";
import { validateOrderMutation, executeOrderMutation, mutationIdempotencyKey } from "../lib/order-mutations.mjs";
import { validateOfferBody } from "../lib/offer-schema.mjs";
import {validateLineReferences,applyOfferLineReferences} from "../lib/offer-reference-lines.mjs";
import {validateCustomerTariffRequest,saveCustomerTariff} from "../lib/customer-tariffs.mjs";
import {validateCustomerNoteRequest,appendCustomerNote} from "../lib/customer-notes.mjs";
import {validateOrderDocumentRequest,attachOrderPdf,removeOrderPdf} from "../lib/order-documents.mjs";
import {validateDeletionRequest,assertDeletionProof,executeDeletion} from '../lib/guarded-deletes.mjs';
import {executeOfferHeaderUpdate} from "../lib/offer-header-update.mjs";
import {contractorScope, validateApiRequest} from "../lib/api-contract.mjs";
import {nativeApiAction,preparedApiRequest,assertProviderContract,stableApiKey,validateAccountingBody,accountingReadback,verifyGenericReadback} from "../lib/api-request.mjs";

const ACTION_TYPES = new Set([
  "api_request",
  "create_customer",
  "append_customer_note",
  "create_customer_tariff",
  "update_customer_tariff",
  "delete_customer_tariff",
  "delete_offer",
  "attach_offer_pdf",
  "attach_order_pdf",
  "remove_order_pdf",
  "create_offer",
  "update_offer",
  "convert_offer_to_order",
  "update_order_status",
  "record_order_delivery",
  "update_order",
  "create_purchase_invoice",
  "update_purchase_invoice_status",
  "validate_accounting_entries",
  "import_accounting_entries",
]);

const dataDirectory =
  process.env.SIBEMA_DATA_DIR?.trim() || "/opt/trinalum/data/sibema";
const actionMode =
  process.env.SIBEMA_ACTION_MODE?.trim().toLowerCase() || "review_only";
let store;
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
store = new SibemaStore(
  process.env.SIBEMA_DB_PATH?.trim() || join(dataDirectory, "sibema.sqlite"),
);

try {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));
  if (command === "prepare") {
    const action = validateAction(
      JSON.parse(await readFile(requiredArg(args, "input"), "utf8")),
    );
    if(['delete_customer_tariff','delete_offer'].includes(action.type))assertDeletionProof(new SibemaClient(),action.type==='delete_offer'?'offer':'tariff',action.request,action.requestedBy);
    const stored = store.prepareApprovedAction(action);
    print({
      status: stored.status,
      action: actionPreview(stored, true),
      next: `Show and approve the exact action before executing ${stored.action_id}`,
    });
  } else if (command === "show") {
    const stored = requiredStoredAction(requiredArg(args, "action-id"));
    print({ status: stored.status, action: actionPreview(stored, true) });
  } else if (command === "execute") {
    assertExecutionMode(actionMode);
    if (!args["confirmed-exact-action"]) {
      throw new Error("--confirmed-exact-action is required");
    }
    const actionId = requiredArg(args, "action-id");
    const approvedBy = canonicalUser(requiredArg(args, "approved-by"));
    let stored = requiredStoredAction(actionId);
    if (stored.requested_by !== approvedBy) {
      throw new Error("The approving user must be the user who requested the exact action");
    }
    if (stored.status === "completed") {
      print({
        status: "already_completed",
        actionId,
        executedAt: stored.executed_at,
        result: parseJson(stored.result_json),
        readback: parseJson(stored.readback_json),
      });
    } else {
      const action = {
        id: stored.action_id,
        type: stored.action_type,
        request: JSON.parse(stored.request_json),
        requestedBy: stored.requested_by,
      };
      let pdfFence = null, claimed = false;
      try {
        if (["attach_order_pdf","remove_order_pdf"].includes(action.type)) pdfFence = store.claimOrderPdfOrder(action.request.orderId, actionId,{claimApproved:true,approvedBy});
        else {
          stored = store.approveAction(actionId,approvedBy);
          if (!store.claimApprovedAction(actionId)) throw new Error(`SIBEMA action ${actionId} could not be claimed`);
        }
        claimed = true;
        const sibema = new SibemaClient();
        const {result,readback}=await executeAction(sibema,action,{deletionFence:store,pdfDispatchGuard:pdfFence?()=>store.dispatchOrderPdfOrder(pdfFence):undefined});
        store.completeApprovedAction(actionId,result,readback);
        if (pdfFence) store.releaseCompletedOrderPdf(pdfFence);
        print({status:"completed",actionId,result,readback});
      } catch (error) {
        if(claimed)store.failApprovedAction(actionId, error);
        if(pdfFence)store.releaseOrderPdfChecking(pdfFence);
        throw error;
      }
    }
  } else {
    throw new Error(
      "Usage: sibema-action.mjs prepare --input FILE | show --action-id ID | execute --action-id ID --approved-by NAME --confirmed-exact-action",
    );
  }
} catch (error) {
  console.error(JSON.stringify({
    status: "error",
    code: error.code ?? null,
    httpStatus: error.status ?? null,
    message: error.message,
  }));
  process.exitCode = 1;
} finally {
  store.close();
}
}

export function validateAction(action) {
  if (!action || typeof action !== "object") throw new Error("Action must be JSON");
  if (typeof action.id !== "string" || action.id.trim().length < 8) {
    throw new Error("Action id must contain at least 8 characters");
  }
  if (!ACTION_TYPES.has(action.type)) {
    throw new Error(`Unsupported SIBEMA action type: ${action.type}`);
  }
  if (!action.request || typeof action.request !== "object") {
    throw new Error("Action request is required");
  }
  const requestedBy = canonicalUser(action.requestedBy);
  validateLineReferences(action);
  if(action.type === "api_request") {
    const normalized={...action,requestedBy,request:preparedApiRequest(action)};
    validateAction(nativeApiAction(normalized).native);
    return {...normalized,id:action.id.trim()};
  }
  if (requestedBy === "Tristan" && !["validate_accounting_entries", "import_accounting_entries"].includes(action.type)) throw new Error("Tristan may approve accounting entries only");
  const body = action.request.body ?? {};
  contractorScope(body);
  if(action.type === "create_purchase_invoice" && body.contractor_id === undefined) body.contractor_id=1;
  if(["validate_accounting_entries","import_accounting_entries"].includes(action.type)) {
    for(const entry of body.entries??[]) if(entry.contractor_id===undefined) entry.contractor_id=1;
    validateApiRequest({method:"POST",path:action.type==="validate_accounting_entries"?"/accounting/entries/validate":"/accounting/entries",body});
    validateAccountingBody(body);
  }
  if (["create_offer","update_offer"].includes(action.type)) validateOfferBody(body);
  if (action.type === "create_offer") requiredId(body.customer_id, "customer_id");
  if (action.type === "convert_offer_to_order") requiredId(body.contractor_id, "contractor_id");
  if (Array.isArray(body.lines) && ["create_offer","update_offer"].includes(action.type)) {
    for (const line of body.lines) {
      requiredId(line.product_id,"lines.product_id");
      if (line.unit_id != null) requiredId(line.unit_id,"lines.unit_id");
      if (line.quantity_from != null && !Number.isFinite(Number(line.quantity_from))) throw new Error("Invalid offer quantity");
      if (line.price != null && !Number.isFinite(Number(line.price))) throw new Error("Invalid offer price");
      if ("quantity" in line || "unit_price" in line) throw new Error("Offer lines use quantity_from and price; do not send order-line fields");
    }
  }
  operationFor(action);
  return { ...action, id: action.id.trim(), requestedBy };
}

export function operationFor(action) {
  if(action.type === "api_request") return operationFor(nativeApiAction(action).native);
  const request = action.request;
  const body = requiredObject(request.body, "request.body");
  contractorScope(body);
  switch (action.type) {
    case "delete_customer_tariff":
    case "delete_offer": {
      const kind=action.type==='delete_offer'?'offer':'tariff';validateDeletionRequest(kind,request);
      return {method:'DELETE',path:'/rest/'+(kind==='tariff'?'customerproduct':'customeroffer')+'/delete/'+request[kind==='tariff'?'tariffId':'offerId'],body};
    }
    case "create_customer_tariff":
    case "update_customer_tariff": {
      validateCustomerTariffRequest(request,{update:action.type==="update_customer_tariff"});
      return {method:"PUT",path:"/rest/customerproduct/update",body};
    }
    case "append_customer_note": {
      validateCustomerNoteRequest(request);
      return {method:"PUT",path:"/rest/customer/update",body};
    }
    case "attach_order_pdf": {
      validateOrderDocumentRequest(request);return {method:"POST",path:`/orders/${request.orderId}/files`,body};
    }
    case "remove_order_pdf": {
      validateOrderDocumentRequest(request,{remove:true});return {method:"DELETE",path:`/rest/saleorderfile/delete/${request.fileId}`,body};
    }
    case "create_customer": {
      if (!String(body.name ?? "").trim() || !String(body.vat_number ?? "").trim()) {
        throw new Error("Customer name and vat_number are required");
      }
      if (!/^[A-Z0-9-]{7,20}$/i.test(String(body.vat_number))) {
        throw new Error("Invalid customer vat_number format");
      }
      return { method: "POST", path: "/customers", body };
    }
    case "attach_offer_pdf": {
      const filename = String(body.filename ?? "");
      if (!/^[^/\\\0]{1,180}\.pdf$/i.test(filename)) throw new Error("A safe PDF filename is required");
      const base64 = String(body.content_base64 ?? "").replace(/^data:application\/pdf;base64,/i, "");
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error("Invalid PDF base64");
      const bytes = Buffer.from(base64, "base64");
      if (bytes.length < 8 || bytes.length > 15 * 1024 * 1024 || !bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        throw new Error("PDF must start with %PDF- and be no larger than 15 MB");
      }
      return { method: "POST", path: `/offers/${requiredId(request.offerId, "request.offerId")}/files`, body: { filename, content_base64: base64 } };
    }
    case "create_offer":
      return { method: "POST", path: "/offers", body };
    case "update_offer":
      return {
        method: "PUT",
        path: `/offers/${requiredId(request.offerId, "request.offerId")}`,
        body,
      };
    case "convert_offer_to_order": {
      if (Object.keys(body).some(key => !["contractor_id", "date"].includes(key))) {
        throw new Error("Offer conversion accepts only contractor_id and date; delivery quantities and dates are not supported by this endpoint");
      }
      requiredId(body.contractor_id, "contractor_id");
      if (body.contractor_id !== 1) throw new Error("Order conversion requires Trinalum contractor_id=1");
      if (body.date !== undefined && (typeof body.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.date) || !Number.isFinite(Date.parse(body.date)) || new Date(body.date).toISOString().slice(0, 10) !== body.date)) {
        throw new Error("Order date must be a real YYYY-MM-DD date");
      }
      return {
        method: "POST",
        path: `/offers/${requiredId(request.offerId, "request.offerId")}/convert-to-order`,
        body,
      };
    }
    case "record_order_delivery":
    case "update_order": {
      validateOrderMutation(action);
      return { method: action.type === "record_order_delivery" ? "POST" : "PATCH",
        path: `/orders/${request.orderId}${action.type === "record_order_delivery" ? "/deliveries" : ""}`, body };
    }
    case "update_order_status": {
      if (Object.keys(body).length !== 1 || !Object.hasOwn(body, "status_id")) {
        throw new Error("Order status updates accept only status_id; they cannot record partial deliveries, delivered quantities, delivery dates or invoiced quantities");
      }
      requiredId(body.status_id, "status_id");
      if (typeof body.status_id !== "number") throw new Error("status_id must be a verified integer, not text or a boolean");
      return {
        method: "PATCH",
        path: `/orders/${requiredId(request.orderId, "request.orderId")}/status`,
        body,
      };
    }
    case "create_purchase_invoice":
      return { method: "POST", path: "/invoices/purchase", body };
    case "update_purchase_invoice_status":
      return {
        method: "PATCH",
        path: `/invoices/purchase/${requiredId(request.invoiceId, "request.invoiceId")}`,
        body,
      };
    case "validate_accounting_entries":
      return { method: "POST", path: "/accounting/entries/validate", body };
    case "import_accounting_entries":
      return { method: "POST", path: "/accounting/entries", body };
    default:
      throw new Error(`Unsupported SIBEMA action type: ${action.type}`);
  }
}

function assertExecutionMode(mode) {
  if (mode === "review_only") {
    throw new Error("SIBEMA mutation is blocked in review_only");
  }
  if (!["approval_required", "autonomous"].includes(mode)) {
    throw new Error("SIBEMA_ACTION_MODE must be review_only, approval_required or autonomous");
  }
}

async function readBack(sibema, action, result) {
  const request = action.request;
  if (action.type === "create_customer") {
    const id = result?.customer_id ?? result?.id;
    if (!id) throw new Error("SIBEMA did not return a customer ID");
    const customer = await sibema.getObject("customers", id);
    if (String(customer?.vat_number ?? "").toUpperCase() !== String(request.body.vat_number).toUpperCase()) {
      throw new Error("Customer VAT readback mismatch");
    }
    return customer;
  }
  if (action.type === "attach_offer_pdf") {
    const offerId = requiredId(request.offerId, "request.offerId");
    const id = result?.file_id ?? result?.id;
    if (!id || result?.stored !== true) throw new Error("SIBEMA did not confirm stored PDF");
    const files = await sibema.get(`/offers/${offerId}/files`);
    const found = (Array.isArray(files) ? files : files?.data ?? []).find(f => String(f.file_id) === String(id));
    if (!found?.stored || found.filename !== request.body.filename) throw new Error("PDF listing readback mismatch");
    const expected = Buffer.from(String(request.body.content_base64).replace(/^data:application\/pdf;base64,/i, ""), "base64");
    const actual = await sibema.getBinary(`/offers/${offerId}/files/${id}/content`);
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    if (hash(actual) !== hash(expected)) throw new Error("PDF bytes readback mismatch");
    return { file_id: id, offer_id: offerId, filename: found.filename, stored: true, bytes: actual.length, sha256: hash(actual) };
  }
  if (action.type === "create_offer") {
    return readObjectIfPresent(sibema, "offers", result?.offer_id ?? result?.id);
  }
  if (action.type === "update_offer") {
    return sibema.getObject("offers", request.offerId);
  }
  if (action.type === "convert_offer_to_order") {
    return readObjectIfPresent(sibema, "orders", result?.order_id ?? result?.id);
  }
  if (action.type === "update_order_status") {
    const order=await sibema.getObject("orders", request.orderId);
    if(order.status?.id!==request.body.status_id) throw Error("Order status readback mismatch");
    return order;
  }
  if (action.type === "create_purchase_invoice") {
    return readObjectIfPresent(
      sibema,
      "invoices/purchase",
      result?.invoice_id ?? result?.purchase_invoice_id ?? result?.id,
    );
  }
  if (action.type === "update_purchase_invoice_status") {
    const invoice=await sibema.getObject("invoices/purchase", request.invoiceId);
    if(invoice.status?.id!==request.body.status_id) throw Error("Purchase invoice status readback mismatch");
    return invoice;
  }
  if(["validate_accounting_entries","import_accounting_entries"].includes(action.type)) return accountingReadback(sibema,action,result);
  return result;
}

async function readObjectIfPresent(sibema, resource, id) {
  if (id == null) throw new Error("Write returned without a record id; readback required before claiming success");
  return sibema.getObject(resource, id);
}

export function actionPreview(stored, includeRequest = false) {
  const request = JSON.parse(stored.request_json);
  if (request.body?.content_base64) {
    const bytes = Buffer.from(String(request.body.content_base64).replace(/^data:application\/pdf;base64,/i, ""), "base64");
    request.body.content_base64 = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  return {
    id: stored.action_id,
    type: stored.action_type,
    requestHash: stored.request_hash,
    requestedBy: stored.requested_by,
    approvedBy: stored.approved_by,
    createdAt: stored.created_at,
    approvedAt: stored.approved_at,
    executedAt: stored.executed_at,
    ...(includeRequest ? { request } : {}),
  };
}

function requiredStoredAction(actionId) {
  const stored = store.approvedAction(actionId);
  if (!stored) throw new Error(`SIBEMA action ${actionId} was not prepared`);
  return stored;
}

function requiredObject(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requiredId(value, name) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error(`${name} must be a positive integer`);
  return id;
}

function canonicalUser(value) {
  const requested = String(value ?? "").trim().toLocaleLowerCase("es");
  const user = ["David", "Trini", "Miguel", "Nerea", "Tristan"]
    .find((item) => item.toLocaleLowerCase("es") === requested);
  if (!user) throw new Error("requestedBy/approved-by must be David, Trini, Miguel, Nerea or Tristan");
  return user;
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const item = values[index];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument ${item}`);
    const key = item.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function requiredArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

function parseJson(value) {
  return value ? JSON.parse(value) : null;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// One durable dispatch. A successful write followed by any readback failure is
// uncertain; it must never be automatically re-approved/replayed.
export async function executeAction(sibema, storedAction,{deletionFence,pdfDispatchGuard}={}) {
  const action=storedAction.type==="api_request"?nativeApiAction(storedAction).native:storedAction;
  const operation=operationFor(action);
  if(storedAction.type==="api_request") await assertProviderContract(sibema,storedAction);
  if(['delete_customer_tariff','delete_offer'].includes(action.type))return executeDeletion(sibema,action.type==='delete_offer'?'offer':'tariff',action.request,action.requestedBy,{fence:deletionFence,actionId:action.id});
  if(["create_customer_tariff","update_customer_tariff"].includes(action.type)) return saveCustomerTariff(sibema,action.request,{update:action.type==="update_customer_tariff"});
  if(action.type==="append_customer_note") return appendCustomerNote(sibema,action.request);
  if(action.type==="attach_order_pdf") return attachOrderPdf(sibema,action.request,{idempotencyKey:mutationIdempotencyKey(action),dispatchGuard:pdfDispatchGuard});
  if(action.type==="remove_order_pdf") return removeOrderPdf(sibema,action.request,{dispatchGuard:pdfDispatchGuard});
  // Public PUT replaces omitted lines. Never dispatch a header-only edit there.
  if(action.type==="update_offer" && !Object.hasOwn(action.request.body,"lines")) {
    const value=await executeOfferHeaderUpdate(sibema,action);
    return storedAction.type==="api_request" ? {result:value.result,readback:{data:value.readback,verification:verifyGenericReadback(action,value.readback)}} : value;
  }
  if(["record_order_delivery","update_order"].includes(action.type)) return executeOrderMutation(sibema,action,operation);
  let phase="write";
  try {
    const result=await sibema.write(operation.path,{method:operation.method,body:operation.body,idempotencyKey:storedAction.type==="api_request"?stableApiKey(storedAction):action.id});
    phase="readback";
    let readback=await readBack(sibema,action,result);
    if (action.request.lineReferences !== undefined) readback=await applyOfferLineReferences(sibema,action,readback);
    if(storedAction.type==="api_request") return {result,readback:{data:readback,verification:verifyGenericReadback(action,readback)}};
    return {result,readback};
  } catch(error) {
    if(phase==="readback" || ![400,401,403,404,409,422].includes(error.status)) error.outcomeUncertain=true;
    throw error;
  }
}
