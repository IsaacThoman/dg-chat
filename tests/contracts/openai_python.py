import os
import io
import json
import uuid
import base64
import struct

from openai import OpenAI


api_key = os.environ.get("OPENAI_API_KEY")
base_url = os.environ.get("OPENAI_BASE_URL", "http://localhost:8000/v1")
if not api_key:
    raise RuntimeError("OPENAI_API_KEY is required")

client = OpenAI(api_key=api_key, base_url=base_url, max_retries=0)
model = "openai/mock-fast"
responses_model = "contracts-responses/mock-responses"
embedding_model = "contracts/mock-embedding"
audio_model = "contracts/mock-transcribe"
image_model = "contracts/mock-image"
speech_bytes = bytes([73, 68, 51, 4, 0, 0, 0, 0, 0, 0, 0xFF, 0xFB, 0x90, 0x64])


def wav_file() -> bytes:
    # Minimal PCM WAV with one 16-bit sample; enough to exercise MIME sniffing and multipart clients.
    return (
        b"RIFF" + (38).to_bytes(4, "little") + b"WAVEfmt "
        + (16).to_bytes(4, "little") + (1).to_bytes(2, "little")
        + (1).to_bytes(2, "little") + (8000).to_bytes(4, "little")
        + (16000).to_bytes(4, "little") + (2).to_bytes(2, "little")
        + (16).to_bytes(2, "little") + b"data" + (2).to_bytes(4, "little")
        + b"\x00\x00"
    )

models = client.models.list()
if not any(candidate.id == "openai/default" for candidate in models.data):
    raise RuntimeError("Official Python client did not receive the configured upstream model")
if not any(candidate.id == embedding_model for candidate in models.data):
    raise RuntimeError("Official Python client did not receive the embeddings model")
if not any(candidate.id == audio_model for candidate in models.data):
    raise RuntimeError("Official Python client did not receive the transcription model")
if not any(candidate.id == image_model for candidate in models.data):
    raise RuntimeError("Official Python client did not receive the image generation model")
if not any(candidate.id == responses_model for candidate in models.data):
    raise RuntimeError("Official Python client did not receive the native Responses model")

image_replay_key = f"python-image-{uuid.uuid4()}"
def create_image():
    return client.images.generate(
        model=image_model,
        prompt="Python image contract",
        n=1,
        response_format="b64_json",
        size="1024x1024",
        extra_headers={"Idempotency-Key": image_replay_key},
    )

first_image = create_image()
replayed_image = create_image()
image_base64 = first_image.data[0].b64_json
if not image_base64 or replayed_image.data[0].b64_json != image_base64:
    raise RuntimeError("Python images.generate() or its exact replay was invalid")
if base64.b64decode(image_base64)[1:4] != b"PNG":
    raise RuntimeError("Python images.generate() did not return a valid PNG signature")
alternate_image = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
edited_image = client.images.edit(
    model=image_model,
    prompt="Python image edit contract",
    image=[
        ("edit-source-one.png", io.BytesIO(base64.b64decode(image_base64)), "image/png"),
        ("edit-source-two.png", io.BytesIO(alternate_image), "image/png"),
    ],
    response_format="b64_json",
)
if edited_image.data[0].b64_json != image_base64:
    raise RuntimeError("Python images.edit() did not return a valid edited image")
try:
    client.images.generate(
        model=image_model,
        prompt="Invalid image count",
        n=0,
        response_format="b64_json",
    )
except Exception as error:
    if getattr(error, "status_code", None) != 422:
        raise RuntimeError("Python malformed image request did not return compatible 422") from error
else:
    raise RuntimeError("Python malformed image request was accepted")

speech = client.audio.speech.create(
    model=audio_model,
    input="Python speech contract",
    voice="alloy",
)
if speech.read() != speech_bytes:
    raise RuntimeError("Python audio.speech.create() returned invalid MP3 bytes")

speech_replay_key = f"python-speech-{uuid.uuid4()}"
def custom_speech():
    return client.audio.speech.create(
        model=audio_model,
        input="Custom voice contract",
        voice={"id": "voice_contract"},
        instructions="Warmly",
        response_format="wav",
        speed=1.25,
        extra_headers={"Idempotency-Key": speech_replay_key},
    )

first_speech = custom_speech().read()
replayed_speech = custom_speech().read()
if not first_speech.startswith(b"RIFF") or replayed_speech != first_speech:
    raise RuntimeError("Python custom WAV speech or exact replay was invalid")

speech_sse = client.audio.speech.create(
    model=audio_model,
    input="Stream speech",
    voice="alloy",
    stream_format="sse",
).read().decode("utf-8")
if "speech.audio.delta" not in speech_sse or speech_sse.count("speech.audio.done") != 1:
    raise RuntimeError("Python speech SSE contract was invalid")

try:
    client.audio.speech.create(
        model=audio_model,
        input="Invalid speed",
        voice="alloy",
        speed=5,
    )
except Exception as error:
    if getattr(error, "status_code", None) != 422:
        raise RuntimeError("Python malformed speech did not return compatible 422") from error
else:
    raise RuntimeError("Python malformed speech request was accepted")

transcription = client.audio.transcriptions.create(
    file=("python-contract.wav", io.BytesIO(wav_file()), "audio/wav"),
    model=audio_model,
)
if transcription.text != "Mock transcription":
    raise RuntimeError("Python audio.transcriptions.create() returned an invalid response")

transcription_stream = client.audio.transcriptions.create(
    file=("python-stream.wav", io.BytesIO(wav_file()), "audio/wav"),
    model=audio_model,
    stream=True,
    include=["logprobs"],
)
streamed_transcription = ""
transcription_usage = 0
for event in transcription_stream:
    if event.type == "transcript.text.delta":
        streamed_transcription += event.delta
    elif event.type == "transcript.text.done":
        transcription_usage = event.usage.total_tokens if event.usage else 0
if streamed_transcription != "Mock " or transcription_usage != 5:
    raise RuntimeError("Python streaming transcription contract was invalid")

diarized = client.audio.transcriptions.create(
    file=("python-diarized.wav", io.BytesIO(wav_file()), "audio/wav"),
    model=audio_model,
    response_format="diarized_json",
    chunking_strategy="auto",
    extra_body={
        "known_speaker_names": ["agent"],
        "known_speaker_references": ["data:audio/wav;base64,UklGRg=="],
    },
)
if diarized.text != "Mock transcription" or diarized.segments[0].speaker != "agent":
    raise RuntimeError("Python diarized transcription contract was invalid")

replay_key = f"python-audio-{uuid.uuid4()}"
def create_translation():
    return client.audio.translations.create(
        file=("python-translation.wav", io.BytesIO(wav_file()), "audio/wav"),
        model=audio_model,
        extra_headers={"Idempotency-Key": replay_key},
    )

first_translation = create_translation()
replayed_translation = create_translation()
if (
    first_translation.text != "Mock translation"
    or replayed_translation.text != first_translation.text
):
    raise RuntimeError("Python audio.translations.create() or its idempotent replay was invalid")
try:
    client.audio.transcriptions.create(
        file=("python-invalid.wav", io.BytesIO(wav_file()), "audio/wav"),
        model=audio_model,
        language="not_a_language",
    )
except Exception as error:
    if getattr(error, "status_code", None) != 422:
        raise RuntimeError(
            "Python malformed audio request did not return a compatible 422"
        ) from error
else:
    raise RuntimeError("Python malformed audio request was accepted")

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

base64_embeddings = client.embeddings.create(
    model=embedding_model,
    input="Python base64 embedding",
    encoding_format="base64",
)
encoded_embedding = base64_embeddings.data[0].embedding
if not isinstance(encoded_embedding, str):
    raise RuntimeError("Python base64 embeddings did not preserve the encoded vector")
decoded_embedding = base64.b64decode(encoded_embedding)
if len(decoded_embedding) != 16 or abs(struct.unpack("<f", decoded_embedding[:4])[0] - 0.01) > 1e-6:
    raise RuntimeError("Python base64 embedding bytes were invalid")

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

usage_stream = client.chat.completions.create(
    model=model,
    stream=True,
    stream_options={"include_usage": True},
    messages=[{"role": "user", "content": "Python streaming usage contract"}],
)
streamed_usage = 0
for chunk in usage_stream:
    if chunk.usage is not None:
        streamed_usage = chunk.usage.total_tokens
if streamed_usage <= 0:
    raise RuntimeError("Python Chat stream omitted requested terminal usage")

nullable_completion = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "Python nullable Chat contract"}],
    temperature=None,
    max_completion_tokens=None,
    stop=None,
)
if "nullable Chat contract" not in (nullable_completion.choices[0].message.content or ""):
    raise RuntimeError("Python Chat Completions rejected nullable SDK parameters")

response = client.responses.create(model=model, input="Python Responses contract")
if "Python Responses contract" not in response.output_text:
    raise RuntimeError("Python Responses result did not contain the expected content")
if response.store is not False:
    raise RuntimeError("Python Responses result claimed unsupported persistent storage")

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

nullable_response_stream = client.responses.create(
    model=model,
    input="Python nullable Responses contract",
    instructions=None,
    stream=True,
    stream_options={"include_obfuscation": False},
    temperature=None,
    top_p=None,
    parallel_tool_calls=None,
    max_output_tokens=None,
    reasoning=None,
)
nullable_response_text = "".join(
    event.delta
    for event in nullable_response_stream
    if event.type == "response.output_text.delta"
)
if "nullable Responses contract" not in nullable_response_text:
    raise RuntimeError("Python Responses rejected nullable SDK or disabled obfuscation options")

native_completion = client.chat.completions.create(
    model=responses_model,
    messages=[{"role": "user", "content": "Python native Responses chat contract"}],
)
if "native Responses chat contract" not in (native_completion.choices[0].message.content or ""):
    raise RuntimeError("Python Chat Completions did not translate through a Responses upstream")

native_tool_completion = client.chat.completions.create(
    model=responses_model,
    messages=[
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "Inspect this image and look up the weather"},
                {
                    "type": "image_url",
                    "image_url": {
                        "url": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
                        "detail": "low",
                    },
                },
            ],
        }
    ],
    tools=[
        {
            "type": "function",
            "function": {
                "name": "lookup_weather",
                "description": "Look up weather",
                "parameters": {
                    "type": "object",
                    "properties": {"city": {"type": "string"}},
                    "required": ["city"],
                    "additionalProperties": False,
                },
                "strict": True,
            },
        }
    ],
    tool_choice={"type": "function", "function": {"name": "lookup_weather"}},
)
native_tool_call = native_tool_completion.choices[0].message.tool_calls[0]
if (
    native_tool_completion.choices[0].finish_reason != "tool_calls"
    or native_tool_call.type != "function"
    or native_tool_call.function.name != "lookup_weather"
    or json.loads(native_tool_call.function.arguments)["city"] != "New York"
):
    raise RuntimeError("Python native Responses tool or multimodal translation was invalid")

native_tool_result = client.chat.completions.create(
    model=responses_model,
    messages=[
        {"role": "user", "content": "Use the weather tool"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [native_tool_call.model_dump()],
        },
        {
            "role": "tool",
            "tool_call_id": native_tool_call.id,
            "content": '{"temperature":72}',
        },
    ],
)
if "Mock response" not in (native_tool_result.choices[0].message.content or ""):
    raise RuntimeError("Python native Responses tool-result history was not translated")

native_completion_stream = client.chat.completions.create(
    model=responses_model,
    stream=True,
    messages=[{"role": "user", "content": "Python native Responses chat stream"}],
)
native_completion_text = "".join(
    chunk.choices[0].delta.content or ""
    for chunk in native_completion_stream
    if chunk.choices
)
if "native Responses chat stream" not in native_completion_text:
    raise RuntimeError("Python streaming Chat Completions did not use a Responses upstream")

native_response = client.responses.create(
    model=responses_model,
    input="Python native Responses public contract",
)
if "native Responses public contract" not in native_response.output_text:
    raise RuntimeError("Python Responses API did not use a native Responses upstream")

direct_tool_response = client.responses.create(
    model=responses_model,
    input="Python direct Responses tool contract",
    tools=[{
        "type": "function",
        "name": "lookup_weather",
        "description": "Look up weather",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
            "additionalProperties": False,
        },
        "strict": True,
    }],
    tool_choice={"type": "function", "name": "lookup_weather"},
)
direct_tool_call = next(
    (item for item in direct_tool_response.output if item.type == "function_call"),
    None,
)
if (
    direct_tool_call is None
    or direct_tool_call.name != "lookup_weather"
    or json.loads(direct_tool_call.arguments)["city"] != "New York"
):
    raise RuntimeError("Python direct Responses function tool contract was invalid")

stateless_native_response = client.responses.create(
    model=responses_model,
    input=[
        {
            "id": "rs_python_previous",
            "type": "reasoning",
            "summary": [{
                "type": "summary_text",
                "text": "Preserve this prior reasoning item",
            }],
            "encrypted_content": "opaque-python-reasoning-state",
            "status": "completed",
        },
        *[item.model_dump(exclude_none=True) for item in native_response.output],
        {
            "id": "fc_python_previous",
            "type": "function_call",
            "call_id": "call_python_previous",
            "name": "lookup_previous",
            "arguments": '{"query":"python"}',
            "status": "completed",
        },
        {
            "type": "function_call_output",
            "call_id": "call_python_previous",
            "output": "prior Python tool result",
        },
        {
            "type": "message",
            "role": "user",
            "content": [{
                "type": "input_text",
                "text": "Python stateless continuation",
            }],
        },
    ],
)
if "Python stateless continuation" not in stateless_native_response.output_text:
    raise RuntimeError(
        "Python Responses stateless output/reasoning continuation was not preserved"
    )

native_response_stream = client.responses.create(
    model=responses_model,
    input="Python native Responses public stream",
    stream=True,
)
native_response_events = list(native_response_stream)
native_response_text = "".join(
    event.delta
    for event in native_response_events
    if event.type == "response.output_text.delta"
)
if "native Responses public stream" not in native_response_text:
    raise RuntimeError("Python streaming Responses API did not use a native Responses upstream")
if (
    native_response_events[0].type != "response.created"
    or native_response_events[1].type != "response.in_progress"
    or native_response_events[-1].type != "response.completed"
    or any(event.sequence_number != index for index, event in enumerate(native_response_events))
):
    raise RuntimeError("Python Responses stream lifecycle or sequence numbers were invalid")

empty_incomplete_stream = client.responses.create(
    model=responses_model,
    input="Python empty incomplete stream",
    max_output_tokens=1,
    stream=True,
)
empty_incomplete_events = list(empty_incomplete_stream)
if (
    empty_incomplete_events[-1].type != "response.incomplete"
    or any(event.type == "error" for event in empty_incomplete_events)
):
    raise RuntimeError("Python valid empty incomplete Responses stream was rejected")
native_terminal = native_response_events[-1].response
if (
    native_terminal.status != "completed"
    or not native_terminal.output
    or native_terminal.usage is None
):
    raise RuntimeError("Python Responses stream terminal snapshot was incomplete")

with client.responses.stream(
    model=responses_model,
    input="Python managed Responses stream contract",
) as managed_stream:
    managed_response = managed_stream.get_final_response()
if (
    managed_response.status != "completed"
    or "managed Responses stream contract" not in managed_response.output_text
    or managed_response.usage is None
    or managed_response.usage.total_tokens <= 0
):
    raise RuntimeError("Python responses.stream().get_final_response() contract failed")

file_text = f"Python files contract {uuid.uuid4()}\n"
file_bytes = file_text.encode("utf-8")
file_name = f"python-contract-{uuid.uuid4()}.txt"
uploaded = client.files.create(
    file=(file_name, io.BytesIO(file_bytes), "text/plain"),
    purpose="assistants",
)
deleted = False
pagination_uploads = [uploaded]
try:
    if (
        uploaded.object != "file"
        or uploaded.filename != file_name
        or uploaded.bytes != len(file_bytes)
        or uploaded.status != "processed"
    ):
        raise RuntimeError("Python files.create() returned an invalid file object")

    for index in range(2):
        page_text = f"Python paginated file {index} {uuid.uuid4()}\n".encode("utf-8")
        pagination_uploads.append(
            client.files.create(
                file=(
                    f"python-page-{uuid.uuid4()}.txt",
                    io.BytesIO(page_text),
                    "text/plain",
                ),
                purpose="assistants",
            )
        )

    files = client.files.list(limit=1, order="desc", purpose="assistants")
    if (
        len(files.data) != 1
        or files.has_more is not True
        or not files.has_next_page()
    ):
        raise RuntimeError(
            "Python files.list() did not return a compatible bounded first page"
        )
    second_files_page = files.get_next_page()
    if (
        len(second_files_page.data) != 1
        or second_files_page.data[0].id == files.data[0].id
    ):
        raise RuntimeError("Python files.list() cursor repeated or skipped its second page")
    expected_page_ids = {item.id for item in pagination_uploads}
    iterated_page_ids = {
        item.id
        for item in client.files.list(limit=1, order="asc", purpose="assistants")
        if item.id in expected_page_ids
    }
    if iterated_page_ids != expected_page_ids:
        raise RuntimeError(
            "Python files.list() auto-pagination did not visit every uploaded file"
        )
    unrelated_purpose = client.files.list(limit=1, purpose="fine-tune")
    if unrelated_purpose.data or unrelated_purpose.has_more is not False:
        raise RuntimeError("Python files.list() purpose filtering returned unrelated files")

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
    for pagination_upload in pagination_uploads:
        if pagination_upload.id == uploaded.id and deleted:
            continue
        try:
            client.files.delete(pagination_upload.id)
        except Exception:
            pass


def expect_api_error(label, call, status, code=None, error_type=None):
    try:
        call()
    except Exception as error:
        if getattr(error, "status_code", None) != status:
            raise RuntimeError(f"{label} did not return HTTP {status}") from error
        if code is not None and getattr(error, "code", None) != code:
            raise RuntimeError(f"{label} did not return error code {code}") from error
        if error_type is not None and getattr(error, "type", None) != error_type:
            raise RuntimeError(f"{label} did not return error type {error_type}") from error
    else:
        raise RuntimeError(f"{label} was accepted")


expect_api_error(
    "Python malformed Chat Completions request",
    lambda: client.chat.completions.create(model=model, messages=[]),
    422,
    error_type="invalid_request_error",
)
expect_api_error(
    "Python malformed Responses request",
    lambda: client.responses.create(model=model, input=[], max_output_tokens=-1),
    422,
    error_type="invalid_request_error",
)
expect_api_error(
    "Python unsupported stored Response",
    lambda: client.responses.create(model=model, input="must not store", store=True),
    400,
    "unsupported_parameter",
    "invalid_request_error",
)

rate_api_key = os.environ.get("CONTRACT_PYTHON_RATE_API_KEY")
empty_credit_api_key = os.environ.get("CONTRACT_EMPTY_CREDIT_API_KEY")
if not rate_api_key or not empty_credit_api_key:
    raise RuntimeError("Python governance contract API keys are required")
rate_client = OpenAI(api_key=rate_api_key, base_url=base_url, max_retries=0)
rate_client.models.list()
expect_api_error(
    "Python token rate limit",
    lambda: rate_client.models.list(),
    429,
    "rate_limit_exceeded",
    "rate_limit_error",
)
empty_credit_client = OpenAI(
    api_key=empty_credit_api_key,
    base_url=base_url,
    max_retries=0,
)
expect_api_error(
    "Python insufficient credit request",
    lambda: empty_credit_client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Must not dispatch without credit"}],
    ),
    402,
    "insufficient_credit",
)

print("Official OpenAI Python client contracts passed")
