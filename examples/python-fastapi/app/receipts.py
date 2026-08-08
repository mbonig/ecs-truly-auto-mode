import os

import boto3

RECEIPTS_BUCKET = os.environ["RECEIPTS_BUCKET"]


def store_receipt(order_id: int, body: bytes) -> None:
    boto3.client("s3").put_object(
        Bucket=RECEIPTS_BUCKET, Key=f"receipts/{order_id}.pdf", Body=body
    )
