# Experimental open-source anti-spoofing adapter — executive identity

**NOT production certified. NOT spoof-proof. Disabled by default.**

This optional Python process connects a locally reviewed Minivision Silent-Face-Anti-Spoofing model to the signed `EIDE_EXEC_PAD_URL` contract used by the ELEMARKET CompreFace bridge. It adds a random server-chosen `blink`, `turn_left`, or `turn_right` challenge, captured in 3 ordered JPEGs (neutral → challenged action → neutral). The private service evaluates each capture with Minivision's pre-trained RGB anti-spoof classifier and MediaPipe face landmarks; **both** must pass. Three client-supplied frames are not evidence of an uncompromised physical camera. Browser-injected, AI-generated or replayed camera streams remain a threat.

## Required outside components and licenses

1. Review and obtain **minivision-ai/Silent-Face-Anti-Spoofing** with its pretrained `.pth` model weights, appropriate detector resources, and upstream Apache-2.0 license at `integrations/executive-pad/upstream`. Pin and record a vetted commit SHA before production testing. This package deliberately does not distribute the third-party repository or face model weights.
2. Check third-party model/checkpoint licenses and dependencies yourself.
3. Supply the private PAD HMAC secret and unique policy ID in deployment configuration. Never set these in source files.
4. CompreFace and its API key remain separate from the PAD service.
5. Start the optional Compose profile **only for testing**. Ensure `EIDE_EXEC_PAD_URL=http://pad-verifier:8092/v1/presentation-verify` resolves from the bridge on the internal Compose network. There are no public port mappings.

By default `EIDE_PAD_INDEPENDENTLY_ASSESSED=0`, so the service rejects all attempts even with positive classifier scores. **Do not change to 1 on the strength of unit tests.** A reviewed and documented test program is required first, including photo/display/replay/mask/deepfake/virtual-camera attempts, attack rates, threshold calibration, camera orientation, false rejects and authorized account recovery. Record signed results and external review. This flag is an operator assertion, not a certification.

## Still missing for a production executive login

- An independently assessed assurance of the **camera capture path** or compensating hardware-backed FIDO2/WebAuthn security key with origin-bound verification. A browser JavaScript P-256 key stored in IndexedDB is not that assurance.
- Measured, reproducible ISO/IEC 30107-3-oriented PAD assessment on actual target cameras, including determined attack potential and error rates.
- Full Docker runtime verification, memory sizing (PyTorch/OpenCV/MediaPipe may be too heavy for a low-cost VPS), phishing/device-compromise exercises, trusted account-recovery testing, privacy impact assessment, and vulnerability review.

Until these gates are cleared, leave `ELEMARKET_EXEC_FACE_ENABLED=0` and continue using Better Auth + TOTP. No existing authentication routes have been removed.
