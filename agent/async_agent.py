import os, asyncio, logging, json
from typing import Dict, Any
from strands import Agent
from strands.models.bedrock import BedrockModel
from bedrock_agentcore import BedrockAgentCoreApp
import boto3

from tools import http_get, sleep_seconds, current_time

from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig, RetrievalConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager


log = logging.getLogger("EventDrivenAgent")
logging.basicConfig(level=logging.INFO)

# SNSクライアントの初期化
sns_client = boto3.client('sns')

app = BedrockAgentCoreApp()

MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "jp.anthropic.claude-haiku-4-5-20251001-v1:0")
model = BedrockModel(model_id=MODEL_ID, streaming=False)

# AgentCore Memory 設定（環境変数から取得）
MEMORY_ID = os.environ.get("AGENTCORE_MEMORY_ID")
SESSION_ID = os.environ.get("AGENTCORE_SESSION_ID", "event_driven_session")
ACTOR_ID = os.environ.get("AGENTCORE_ACTOR_ID", "event_driven_agent")
MEMORY_STRATEGY_ID = os.environ.get("AGENTCORE_MEMORY_STRATEGY_ID")

SYSTEM_PROMPT = """あなたはイベント駆動型のAIエージェントです。
EventBridge経由で受信したイベントに基づいてタスクを実行します。

## メモリコンテキスト
過去の実行履歴にアクセスできます。このコンテキストを活用して：
- 過去の実行内容を把握
- 重複した情報を避ける
- 過去の結果を踏まえた処理を行う

## 利用可能なツール
- `http_get`: URLからデータを取得
- `current_time`: 現在時刻を取得
- `sleep_seconds`: 指定秒数待機

## 動作ルール
1. 受信したイベントの内容を理解する
2. 必要に応じてツールを使用してタスクを実行
3. 結果を簡潔に日本語で報告

## イベント処理例
- 「最新ニュースを取得」→ http_get で情報収集
- 「現在時刻を教えて」→ current_time で取得
- 「〇〇について調べて」→ http_get で検索・調査

常に簡潔で実用的な回答を心がけてください。
"""

# メモリー設定を作成
memory_config = AgentCoreMemoryConfig(
    memory_id=MEMORY_ID,
    session_id=SESSION_ID,
    actor_id=ACTOR_ID,
    retrieval_config={
        f"/strategies/{MEMORY_STRATEGY_ID}/actors/{ACTOR_ID}/sessions/{SESSION_ID}":
            RetrievalConfig(top_k=5, relevance_score=0.3)
    }
)

# セッションマネージャーを作成
session_manager = AgentCoreMemorySessionManager(
    agentcore_memory_config=memory_config
)

agent = Agent(
    model=model,
    tools=[http_get, sleep_seconds, current_time],
    system_prompt=SYSTEM_PROMPT,
    session_manager=session_manager
)

# --- SNS通知送信関数 ---
async def send_sns_notification(job_id: str, status: str, message: str, result: Any = None):
    """エージェント処理完了後にSNS通知を送信"""
    topic_arn = os.environ.get("SNS_TOPIC_ARN")
    if not topic_arn:
        log.warning("[SNS] SNS_TOPIC_ARN環境変数が未設定のため通知スキップ")
        return

    try:
        notification_data = {
            "job_id": job_id,
            "status": status,
            "message": message,
        }

        if result:
            result_str = str(result)
            if len(result_str) > 1000:
                result_str = result_str[:1000] + "...(truncated)"
            notification_data["result"] = result_str

        await asyncio.to_thread(
            sns_client.publish,
            TopicArn=topic_arn,
            Subject=f"[AgentCore] {status.upper()}: {job_id}",
            Message=json.dumps(notification_data, indent=2, ensure_ascii=False)
        )
        log.info("[SNS] 通知送信完了: job=%s, status=%s", job_id, status)

    except Exception as e:
        log.error("[SNS] 通知送信失敗: %s", e)

# --- バックグラウンド処理 ---
async def _background_run(task_id: int, payload: Dict[str, Any], context):
    job_id = payload.get("job_id", "event-job")
    result = None

    try:
        seconds = int(payload.get("seconds", 0) or 0)
        if seconds > 0:
            await asyncio.sleep(seconds)

        user_input = payload.get("input") or "現在時刻を教えてください。"
        log.info("[EventDrivenAgent] job=%s | input=%s", job_id, user_input)

        result = await agent.invoke_async(user_input)
        log.info("[EventDrivenAgent] job=%s | completed | result=%s", job_id, str(result)[:500])

        await send_sns_notification(
            job_id=job_id,
            status="success",
            message="イベント処理が完了しました",
            result=result
        )

    except Exception as e:
        log.exception("[EventDrivenAgent] job failed: %s", e)
        await send_sns_notification(
            job_id=job_id,
            status="error",
            message=f"エラー: {str(e)}"
        )

    finally:
        app.complete_async_task(task_id)
        log.info("[EventDrivenAgent] job=%s | task released", job_id)

# --- エントリポイント ---
@app.entrypoint
async def main(payload: Dict[str, Any], context=None):
    """
    EventBridge から呼び出されるエントリポイント

    Expected payload:
    {
        "action": "start",
        "job_id": "unique-job-id",
        "input": "エージェントへの指示",
        "seconds": 0  # オプション: 待機秒数
    }
    """
    if payload.get("action") == "start":
        task_id = app.add_async_task("event_job", {"job_id": payload.get("job_id")})
        asyncio.create_task(_background_run(task_id, payload, context))
        return {"status": "started", "task_id": task_id, "job_id": payload.get("job_id")}

    return {"status": "noop", "message": "action must be 'start'"}

if __name__ == "__main__":
    app.run()
