"""One financial preview/write for a batch, with durable per-receipt inventory recovery."""

import json
from uuid import UUID, uuid5

from filelock import FileLock, Timeout

from .fulfillment_models import ReceiptBatchInput, ReceiptInput
from .grocy import Grocy
from .ledger import LedgerError
from .models import BatchItem, BatchMutation, OrderInput
from .receipt_flow import ReceiptFlow


class ReceiptBatch:
    def __init__(self, writer):
        self.writer = writer
        self.flow = ReceiptFlow(writer)

    def read(self, identity):
        identity = str(UUID(identity))
        with self.writer.database() as db:
            row = db.execute("SELECT * FROM receipt_batches WHERE id=?", (identity,)).fetchone()
        if not row:
            raise LedgerError("批量收货预览不存在，请恢复原请求")
        return ReceiptBatchInput.model_validate_json(row["request"]), json.loads(row["result"])

    def save(self, result):
        with self.writer.database() as db:
            db.execute(
                "UPDATE receipt_batches SET result=? WHERE id=?",
                (json.dumps(result), result["request_id"]),
            )
        return result

    def preview(self, request):
        identity = str(request.request_id)
        with self.writer.guard():
            with self.writer.database() as db:
                saved = db.execute(
                    "SELECT * FROM receipt_batches WHERE id=?", (identity,)
                ).fetchone()
            if saved:
                if json.loads(saved["request"]) != request.model_dump(mode="json"):
                    raise LedgerError("批量收货编号已用于不同内容")
                return json.loads(saved["result"])
            if len({r.order_id for r in request.receipts}) != len(request.receipts):
                raise LedgerError("同一批次不能重复选择订单")
            if len({r.request_id for r in request.receipts}) != len(request.receipts):
                raise LedgerError("收货请求编号不能重复")
            docs = {o["id"]: o for o in self.flow.orders.list()}
            linked = any(
                i["product_id"]
                for r in request.receipts
                for i in docs.get(r.order_id, {}).get("items", [])
            )
            options = Grocy(self.writer.state).receipt_options() if linked else None
            receipts = [
                self.flow.preview(r, batch_id=identity, options=options) for r in request.receipts
            ]
            items = [
                BatchItem(
                    order=OrderInput(
                        kind="settle",
                        source_id=docs[r.order_id]["source"]["id"],
                        date=r.settlement.date,
                        amount=str(r.settlement.amount),
                        account=r.settlement.account,
                    )
                )
                for r in request.receipts
                if r.settlement
            ]
            financial = (
                self.writer.preview(
                    BatchMutation(
                        request_id=uuid5(request.request_id, "settlement"),
                        revision=self.writer.ledger.refresh().revision,
                        items=items,
                    )
                )
                if items
                else None
            )
            result = {
                "request_id": identity,
                "financial": financial,
                "receipts": receipts,
                "status": "preview",
            }
            with self.writer.database() as db:
                for request_row, receipt in zip(request.receipts, receipts, strict=True):
                    if request_row.settlement:
                        receipt.update(financial=financial, settlement_status="pending")
                    db.execute(
                        "UPDATE receipt_previews SET result=? WHERE id=?",
                        (json.dumps(receipt), receipt["request_id"]),
                    )
                db.execute(
                    "INSERT INTO receipt_batches VALUES (?,?,?)",
                    (identity, request.model_dump_json(), json.dumps(result)),
                )
            return result

    def commit(self, identity):
        return self._locked(identity, self._commit)

    def cancel(self, identity):
        return self._locked(identity, self._cancel)

    def _locked(self, identity, action):
        identity = str(UUID(identity))
        try:
            with FileLock(str(self.writer.state / f"receipt-batch-{identity}.lock"), timeout=0):
                return action(identity)
        except Timeout as exc:
            raise LedgerError("该批次正在处理，请稍后恢复原批次") from exc

    def _commit(self, identity):
        with self.writer.guard():
            request, result = self.read(identity)
            identity = str(request.request_id)
            if result["status"] == "cancelled":
                raise LedgerError("该批次已取消，请重新预览")
            # Validate every receipt before the shared bill can be written.
            for receipt in result["receipts"]:
                with self.writer.database() as db:
                    row = db.execute(
                        "SELECT prepared,result FROM receipt_previews WHERE id=?",
                        (receipt["request_id"],),
                    ).fetchone()
                self.flow.validate_commit(
                    ReceiptInput.model_validate_json(row["prepared"]), json.loads(row["result"])
                )
            if result["financial"]:
                self.writer.commit(result["financial"]["request_id"])
            result["status"] = "processing"
            self.save(result)
        for index, receipt in enumerate(result["receipts"]):
            try:
                result["receipts"][index] = self.flow.commit(
                    receipt["request_id"], batch_id=identity
                )
            except (ValueError, OSError) as exc:
                result["receipts"][index] = receipt | {"error": str(exc)}
        result["status"] = (
            "done"
            if all(
                r["receipt_saved"]
                and not r.get("error")
                and r["settlement_status"] in ("none", "done")
                for r in result["receipts"]
            )
            else "needs_review"
        )
        return self.save(result)

    def _cancel(self, identity):
        with self.writer.guard():
            request, result = self.read(identity)
            with self.writer.database() as db:
                if any(
                    db.execute("SELECT 1 FROM receipts WHERE id=?", (str(r.request_id),)).fetchone()
                    for r in request.receipts
                ):
                    raise LedgerError("已有订单保存收货，请恢复原批次，不能重新提交")
            if result["financial"]:
                cancelled = self.writer.cancel_preview(result["financial"]["request_id"])
                if cancelled["status"] == "done":
                    raise LedgerError("整批账单已保存，请恢复原批次继续入库")
            with self.writer.database() as db:
                for r in request.receipts:
                    row = db.execute(
                        "SELECT result FROM receipt_previews WHERE id=?", (str(r.request_id),)
                    ).fetchone()
                    child = json.loads(row["result"]) | {"cancelled": True}
                    db.execute(
                        "UPDATE receipt_previews SET result=? WHERE id=?",
                        (json.dumps(child), str(r.request_id)),
                    )
            result["status"] = "cancelled"
            return self.save(result)
