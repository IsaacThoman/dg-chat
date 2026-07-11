import os
import io
import io
import uuid
import base64

from openai import OpenAI


api_key = os.environ.get("OPENAI_API_KEY")
base_url = os.environ.get("OPENAI_BASE_URL", "http://localhost:8000/v1")
if not api_key:
    raise RuntimeError("OPENAI_API_KEY is required")

client = OpenAI(api_key=api_key, base_url=base_url, max_retries=0)
model = "openai/mock-fast"
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
