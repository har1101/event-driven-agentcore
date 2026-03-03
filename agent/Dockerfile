FROM public.ecr.aws/docker/library/python:3.13-slim
WORKDIR /app

RUN pip install --no-cache-dir uv
ENV UV_SYSTEM_PYTHON=1 UV_COMPILE_BYTECODE=1

COPY requirements.txt requirements.txt
RUN uv pip install --system -r requirements.txt

ENV AWS_REGION=ap-northeast-1
ENV AWS_DEFAULT_REGION=ap-northeast-1
ENV DOCKER_CONTAINER=1

RUN useradd -m -u 1000 bedrock_agentcore
USER bedrock_agentcore

COPY . .
EXPOSE 8080

CMD ["opentelemetry-instrument", "python", "-m", "async_agent"]