import os
import io
import uuid

from openai import OpenAI


api_key = os.environ.get("OPENAI_API_KEY")
base_url = os.environ.get("OPENAI_BASE_URL", "http://localhost:8000/v1")
if not api_key:
    raise RuntimeError("OPENAI_API_KEY is required")

client = OpenAI(api_key=api_key, base_url=base_url, max_retries=0)
model = "openai/mock-fast"
embedding_model = "contracts/mock-embedding"

models = client.models.list()
if not any(candidate.id == "openai/default" for candidate in models.data):
    raise RuntimeError("Official Python client did not receive the configured upstream model")
if not any(candidate.id == embedding_model for candidate in models.data):
    raise RuntimeError("Official Python client did not receive the embeddings model")

embeddings = client.embeddings.create(
    model=embedding_model,
    input=["Python embeddings one", "Python embeddings two"],
    encoding_format="float",
)
if (
    embeddings.object != "list"
    or embeddings.model != embedding_model
    or len(embeddings.data) != 2
    or embeddings.data[0].index != 0
    or embeddings.data[1].index != 1
    or embeddings.data[0].embedding != [0.1, 0.2, 0.3, 0.4]
    or embeddings.usage.prompt_tokens != 2
    or embeddings.usage.total_tokens != 2
):
    raise RuntimeError("Python embeddings.create() returned an invalid response")

completion = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "Python SDK contract"}],
)
completion_text = completion.choices[0].message.content or ""
if "Python SDK contract" not in completion_text:
    raise RuntimeError("Python non-streaming completion did not contain the expected content")

stream = client.chat.completions.create(
    model=model,
    stream=True,
    messages=[{"role": "user", "content": "Python streaming contract"}],
)
streamed_text = "".join((chunk.choices[0].delta.content or "") for chunk in stream)
if "Python streaming contract" not in streamed_text:
    raise RuntimeError("Python streaming completion did not contain the expected content")

response = client.responses.create(model=model, input="Python Responses contract")
if "Python Responses contract" not in response.output_text:
    raise RuntimeError("Python Responses result did not contain the expected content")

response_stream = client.responses.create(
    model=model,
    input="Python Responses streaming contract",
    stream=True,
)
response_stream_text = "".join(
    event.delta for event in response_stream if event.type == "response.output_text.delta"
)
if "Python Responses streaming contract" not in response_stream_text:
    raise RuntimeError("Python Responses stream did not contain the expected content")

file_text = f"Python files contract {uuid.uuid4()}\n"
file_bytes = file_text.encode("utf-8")
file_name = f"python-contract-{uuid.uuid4()}.txt"
uploaded = client.files.create(
    file=(file_name, io.BytesIO(file_bytes), "text/plain"),
    purpose="assistants",
)
deleted = False
try:
    if (
        uploaded.object != "file"
        or uploaded.filename != file_name
        or uploaded.bytes != len(file_bytes)
        or uploaded.status != "processed"
    ):
        raise RuntimeError("Python files.create() returned an invalid file object")

    files = client.files.list()
    if (
        not isinstance(files.data, list)
        or files.has_more is not False
        or not any(item.id == uploaded.id for item in files.data)
    ):
        raise RuntimeError("Python files.list() did not include the uploaded file")

    retrieved = client.files.retrieve(uploaded.id)
    if retrieved.id != uploaded.id or retrieved.filename != file_name:
        raise RuntimeError("Python files.retrieve() returned the wrong file")

    content = client.files.content(uploaded.id)
    if content.read() != file_bytes:
        raise RuntimeError("Python files.content() did not preserve the uploaded bytes")

    result = client.files.delete(uploaded.id)
    deleted = True
    if result.id != uploaded.id or result.object != "file" or result.deleted is not True:
        raise RuntimeError("Python files.delete() returned an invalid deletion object")

    try:
        client.files.retrieve(uploaded.id)
    except Exception as error:
        if getattr(error, "status_code", None) != 404:
            raise RuntimeError(
                "Python deleted file did not return an OpenAI-compatible 404"
            ) from error
    else:
        raise RuntimeError("Python deleted file remained retrievable")
finally:
    if not deleted:
        try:
            client.files.delete(uploaded.id)
        except Exception:
            pass

print("Official OpenAI Python client contracts passed")
