import os

from openai import OpenAI


api_key = os.environ.get("OPENAI_API_KEY")
base_url = os.environ.get("OPENAI_BASE_URL", "http://localhost:8000/v1")
if not api_key:
    raise RuntimeError("OPENAI_API_KEY is required")

client = OpenAI(api_key=api_key, base_url=base_url, max_retries=0)
model = "openai/mock-fast"

models = client.models.list()
if not any(candidate.id == "openai/default" for candidate in models.data):
    raise RuntimeError("Official Python client did not receive the configured upstream model")

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

files = client.files.list()
if not isinstance(files.data, list):
    raise RuntimeError("Python files.list() did not return a list")

print("Official OpenAI Python client contracts passed")
