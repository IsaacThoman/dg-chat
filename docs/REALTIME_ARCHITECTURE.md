# Client/server streaming and Realtime architecture

## Current transport map

DG Chat's existing browser and OpenAI-compatible traffic is HTTP-based:

- Ordinary browser API operations use authenticated JSON requests under `/api`.
- Chat generation uses a streaming `fetch()` request whose response is Server-Sent Events (SSE).
  Events carry a generation ID and a strictly increasing sequence. The client rejects gaps or
  mismatched generations, and disconnect/stop signals cancel upstream work where possible.
- OpenAI-compatible Chat Completions, Responses, transcription, speech, and image streams also use
  SSE over HTTP. Binary audio and file bodies use bounded streamed HTTP responses.
- Upload progress uses `XMLHttpRequest` because browsers still do not expose equivalent upload
  progress for ordinary `fetch()` requests.

SSE is deliberately retained for request/response generation: it traverses common reverse proxies
well, uses ordinary HTTP authentication and observability, and matches the OpenAI streaming APIs. It
is one-way after request submission, so it is not the transport for a live audio conversation.

## Realtime transport map

The public Realtime compatibility surface follows the OpenAI protocol rather than inventing a DG
Chat framing layer:

| Use case                                       | Transport                                                                           | Reason                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Trusted server client or media pipeline        | Raw WebSocket at `/v1/realtime`                                                     | Required OpenAI-compatible bidirectional JSON event protocol                   |
| First-party browser live voice                 | WebRTC audio plus data channel                                                      | Lower-latency media, congestion handling, and browser-native echo cancellation |
| Browser/session establishment and call control | HTTP under `/v1/realtime/*` and cookie-authenticated `/api/realtime/*` counterparts | Keeps durable credentials server-side and matches the official REST contract   |
| Existing text/image/audio generation           | HTTP plus SSE or binary streaming                                                   | Already reliable and protocol-compatible for one-way output                    |

Socket.IO is not used on `/v1/realtime`. Socket.IO adds Engine.IO negotiation, packet framing, and
acknowledgement semantics that a standard OpenAI Realtime WebSocket client does not speak. It may be
appropriate for a separate DG-only notification channel later, but wrapping the compatibility
endpoint would make it incompatible without improving WebRTC media delivery.

## Reliability contract

Transport reconnect alone cannot guarantee a correct model session. DG Chat therefore treats
reliability as an application and accounting property:

- authenticate and authorize before provider work starts;
- enforce bounded event, buffered-byte, audio, session-duration, and idle limits;
- preserve ordering and reject malformed or oversized protocol events;
- apply flow control and terminate slow consumers before memory becomes unbounded;
- emit heartbeats where the transport supports them and use explicit close/error codes;
- make reservation and terminal settlement idempotent so reconnects cannot double-charge;
- retain server-side call ownership and short-lived client-secret metadata in shared storage so a
  different replica can authorize control requests;
- use the Realtime sideband connection for server-owned tools, policy enforcement, usage capture,
  and interruption/cancellation state;
- expose metrics for active sessions, event/audio bytes, backpressure, abnormal closes, upstream
  errors, latency, and unsettled accounting;
- on reconnect, resynchronize from durable conversation state when supported. The server must never
  claim transparent replay for ephemeral audio/events that the upstream protocol cannot replay.

The first-party WebRTC client can reconnect and rebuild a session from retained conversation state,
but it presents this as a new media session. It does not pretend that an interrupted RTP stream was
losslessly resumed.
