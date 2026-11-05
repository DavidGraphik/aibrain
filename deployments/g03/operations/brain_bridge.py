"""Local stdio MCP candidate. Reuses per-user G03 HTTP authorization.

Requires G03_TOOLS_URL=http://127.0.0.1:<port> and G03_TOOLS_SESSION in
the private employee environment. Never provision a shared administrator token.
No model, external connector, mailbox or Windows action is performed here.
"""
import json
import os
import sys
from urllib.parse import urlparse, quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError

TOOLS = [
    {"name": "g03_list_work_orders", "description": "Read current rehearsal work orders; source is synthetic, not live V6.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "g03_machine_queue", "description": "Read synthetic work orders and phases assigned to one machine, ordered by priority.", "inputSchema": {"type": "object", "properties": {"machine": {"type": "string"}}, "required": ["machine"], "additionalProperties": False}},
    {"name": "g03_delivery_risk", "description": "Compute risk from synthetic orders for an explicit date; disclose absent material/date data.", "inputSchema": {"type": "object", "properties": {"asOf": {"type": "string", "format": "date"}}, "required": ["asOf"], "additionalProperties": False}},
    {"name": "g03_read_department", "description": "Read an authorized operational resource; HTTP role checks remain authoritative.", "inputSchema": {"type": "object", "properties": {"resource": {"type": "string", "enum": ["stock", "warehouse", "quality", "quotes", "purchases", "sales", "references", "maintenance", "tools", "mail", "outbox", "audit"]}}, "required": ["resource"], "additionalProperties": False}},
    {"name": "g03_list_documents", "description": "List authorized synthetic documents, not actual Windows files.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "g03_read_document", "description": "Read a bounded authorized fixture with provenance and hash; no writes.", "inputSchema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False}},
    {"name": "g03_connection_status", "description": "Read actual candidate connection states; never treat fixtures as connected providers.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
    {"name": "g03_purchase_demand", "description": "Read synthetic material demand and stock; no conversions or purchase dispatch.", "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}},
]


def call(name, arguments, fetch):
    if not isinstance(arguments, dict): raise ValueError("INVALID_ARGUMENTS")
    if name == "g03_list_work_orders": return fetch("/api/orders")
    if name == "g03_machine_queue":
        machine = arguments["machine"]
        if not isinstance(machine, str): raise ValueError("INVALID_MACHINE")
        orders, phases = fetch("/api/orders"), fetch("/api/phases")
        return sorted([{**o, "sourceType": "order"} for o in orders if o.get("assignedMachine") == machine and o.get("productionStatus") != "ACABAT"] + [{**p, "sourceType": "phase"} for p in phases if p.get("machine") == machine and p.get("status") != "ACABAT"], key=lambda x: x.get("priority", 999))
    if name == "g03_delivery_risk":
        from datetime import date
        as_of = date.fromisoformat(arguments["asOf"]).isoformat()
        result = []
        for order in fetch("/api/orders"):
            reasons = []
            if not order.get("deliveryDate"): reasons.append("DATA_ENTREGA_DESCONEGUDA")
            elif order["deliveryDate"] < as_of and order["unitsDelivered"] < order["units"]: reasons.append("ENTREGA_PENDENT_FORA_TERMINI")
            if order.get("materialStatus") != "REBUT": reasons.append("MATERIAL_PENDENT_O_DESCONEGUT")
            if not order.get("assignedMachine"): reasons.append("MAQUINA_PENDENT")
            if reasons: result.append({"workOrder": order["id"], "reasons": reasons})
        return {"asOf": as_of, "source": "synthetic-fixture", "risks": result, "productionUpdates": 0}
    if name == "g03_read_department":
        resource = arguments["resource"]
        if resource not in TOOLS[3]["inputSchema"]["properties"]["resource"]["enum"]: raise ValueError("INVALID_RESOURCE")
        return fetch("/api/" + resource)
    if name == "g03_list_documents": return fetch("/api/files")
    if name == "g03_read_document": return fetch("/api/files/read?path=" + quote(arguments["path"], safe=""))
    if name == "g03_connection_status": return fetch("/api/connections")
    if name == "g03_purchase_demand":
        orders, stock = fetch("/api/orders"), {s["id"]: s for s in fetch("/api/stock")}
        required, pending = {}, []
        for order in orders:
            if order.get("productionStatus") == "ACABAT": continue
            reference, amount = order.get("materialReference"), order.get("materialRequired")
            if reference not in stock or not isinstance(amount, (int, float)):
                pending.append(order["id"]); continue
            required[reference] = required.get(reference, 0) + max(0, amount - order.get("materialReceived", 0))
        rows = [{"reference": ref, "unit": stock[ref]["unit"], "remainingUnreceivedDemand": amount, "onHand": stock[ref]["quantity"], "unallocatedShortfallCandidate": max(0, amount - stock[ref]["quantity"]), "allocationConfirmed": False} for ref, amount in required.items()]
        return {"source": "synthetic-fixture", "rows": rows, "unmappedOrders": pending, "conversion": "UNDEFINED", "purchaseDispatch": False, "caveat": "Candidate only: stock reservations and raw-to-finished conversions are not confirmed."}
    raise ValueError("UNKNOWN_TOOL")


def configured_fetch():
    base = os.environ.get("G03_TOOLS_URL", "")
    parsed = urlparse(base)
    if parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not parsed.port or parsed.path or parsed.username or parsed.query or parsed.fragment:
        raise ValueError("LOCAL_G03_ENDPOINT_REQUIRED")
    token = os.environ.get("G03_TOOLS_SESSION", "")
    if not token: raise ValueError("EMPLOYEE_SESSION_REQUIRED")
    def fetch(route):
        with urlopen(Request(base + route, headers={"Authorization": "Bearer " + token}), timeout=10) as response:
            return json.load(response)
    return fetch


def dispatch(message, fetch):
    method = message.get("method")
    if method == "initialize":
        return {"protocolVersion": message.get("params", {}).get("protocolVersion", "2024-11-05"), "capabilities": {"tools": {}}, "serverInfo": {"name": "g03-rehearsal", "version": "0.1.0"}}
    if method == "ping": return {}
    if method == "tools/list": return {"tools": TOOLS}
    if method == "tools/call":
        params = message.get("params", {})
        try:
            result = call(params.get("name"), params.get("arguments", {}), fetch)
            return {"content": [{"type": "text", "text": json.dumps({"tenant": "g03-rehearsal", "mode": "synthetic-local", "data": result}, ensure_ascii=False)}], "isError": False}
        except (ValueError, KeyError, HTTPError) as error:
            return {"content": [{"type": "text", "text": "Tool rejected: " + (str(error.code) if isinstance(error, HTTPError) else type(error).__name__)}], "isError": True}
    raise ValueError("METHOD_NOT_FOUND")


def main():
    fetch = configured_fetch()
    for line in sys.stdin:
        try:
            message = json.loads(line)
            if "id" not in message: continue
            result = {"jsonrpc": "2.0", "id": message["id"], "result": dispatch(message, fetch)}
        except (ValueError, TypeError, KeyError):
            result = {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "Invalid request"}}
        print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
