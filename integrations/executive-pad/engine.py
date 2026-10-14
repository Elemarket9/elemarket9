"""ELEMARKET isolated experimental PAD research service.

Uses Minivision Silent-Face-Anti-Spoofing (Apache-2.0 upstream), OpenCV,
and MediaPipe landmarks. Requires an independently supplied/vetted upstream
checkout and weights. Not a certified PAD or camera-origin attestation.

NO POSITIVE AUTHENTICATION ATTESTATION unless an operator explicitly enables
assessed mode after external evaluation. Fail-closed otherwise.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

MAX_BODY = 1_650_000
MAX_FRAME_BYTES = 370_000
MAX_AGE = 120
PROMPTS = frozenset(("turn_left", "turn_right", "blink"))


def hex_hmac(secret: str, value: str) -> str:
    return hmac.new(secret.encode(), value.encode(), hashlib.sha256).hexdigest()


def pad_signature_payload(r: dict) -> str:
    return json.dumps([
        "eide-pad-v1", r["challengeId"], r["nonce"], r["prompt"],
        r["requestDigest"], r["passed"], r["captureBindingVerified"],
        r["policyId"],
    ], separators=(",", ":"))


def validate_request(raw: bytes, secret: str, signature: str) -> dict:
    if len(raw) > MAX_BODY or not hmac.compare_digest(hex_hmac(secret, raw.decode("utf-8")), signature.lower()):
        raise ValueError("Unsigned or oversized request")
    obj = json.loads(raw)
    if not isinstance(obj, dict) or obj.get("prompt") not in PROMPTS:
        raise ValueError("Invalid PAD prompt")
    if not isinstance(obj.get("challengeId"), str):
        raise ValueError("Invalid challenge")
    try:
        if str(uuid.UUID(obj["challengeId"])) != obj["challengeId"].lower():
            raise ValueError("Invalid challenge")
    except (ValueError, AttributeError) as exc:
        raise ValueError("Invalid challenge") from exc
    if not isinstance(obj.get("nonce"), str) or not 32 <= len(obj["nonce"]) <= 128:
        raise ValueError("Invalid nonce")
    frames = obj.get("frames")
    if not isinstance(frames, list) or len(frames) != 3:
        raise ValueError("Expected three ordered frames")
    decoded = []
    for frame in frames:
        if not isinstance(frame, str) or len(frame) > 500_000:
            raise ValueError("Invalid frame")
        jpeg = base64.b64decode(frame, validate=True)
        if not 300 <= len(jpeg) <= MAX_FRAME_BYTES or jpeg[:3] != b"\xff\xd8\xff":
            raise ValueError("Invalid JPEG")
        decoded.append(jpeg)
    if len(set(hashlib.sha256(frame).digest() for frame in decoded)) != 3:
        raise ValueError("Identical frames are not liveness evidence")
    return obj


def eye_ratio(points, indices) -> float:
    import math
    a, b, c, d, e, f = [points[i] for i in indices]
    distance = lambda p, q: math.hypot(p.x - q.x, p.y - q.y)
    width = distance(a, d)
    return (distance(b, f) + distance(c, e)) / (2 * max(width, 1e-5))


def active_sequence_meets_prompt(prompt: str, landmarks, *, yaw_sign: int = 1) -> bool:
    """Heuristic 3-pose challenge, not camera-feed attestation or deepfake defense."""
    if len(landmarks) != 3:
        return False
    if prompt == "blink":
        # 6 landmarks from both eyes, with opening at index pairs (1,5),(2,4).
        left = [eye_ratio(p, (33, 160, 158, 133, 153, 144)) for p in landmarks]
        right = [eye_ratio(p, (362, 385, 387, 263, 373, 380)) for p in landmarks]
        ear = [(x + y) / 2 for x, y in zip(left, right)]
        if min(ear[0], ear[2]) < 0.17:
            return False
        return ear[1] < 0.60 * min(ear[0], ear[2]) and ear[2] > 0.78 * ear[0]
    yaw = []
    for points in landmarks:
        span = abs(points[454].x - points[234].x)
        if span <= 0.07:
            return False
        yaw.append((points[1].x - (points[234].x + points[454].x) / 2) / span)
    # Camera orientation/mirroring must be calibrated per capture pipeline.
    direction = -1 if prompt == "turn_left" else 1
    turn = (yaw[1] - yaw[0]) * direction * yaw_sign
    return turn >= 0.12 and abs(yaw[2] - yaw[0]) <= 0.09


class OpenSourcePadEvaluator:
    def __init__(self, repo: str, model_dir: str, threshold: float, yaw_sign: int):
        import cv2
        import mediapipe as mp
        import numpy as np
        sys.path.insert(0, repo)
        from src.anti_spoof_predict import AntiSpoofPredict
        from src.generate_patches import CropImage
        from src.utility import parse_model_name
        self.cv2, self.np = cv2, np
        self.detector = AntiSpoofPredict(0)
        self.crop = CropImage()
        self.parser = parse_model_name
        self.face_mesh = mp.solutions.face_mesh.FaceMesh(
            static_image_mode=True, max_num_faces=1, refine_landmarks=False,
            min_detection_confidence=0.75,
        )
        models = sorted(Path(model_dir).glob("*.pth"))
        if len(models) < 2:
            raise RuntimeError("At least two pretrained Minivision PAD models required")
        self.models, self.threshold, self.yaw_sign = models, threshold, yaw_sign
        self.lock = threading.Lock()  # upstream predict mutates its internal model

    def evaluate(self, frames: list[str], prompt: str) -> bool:
        with self.lock:
            landmarks = []
            for encoded in frames:
                raw = base64.b64decode(encoded, validate=True)
                image = self.cv2.imdecode(self.np.frombuffer(raw, dtype=self.np.uint8), self.cv2.IMREAD_COLOR)
                if image is None or image.shape[:2] != (320, 240):
                    return False
                result = self.face_mesh.process(self.cv2.cvtColor(image, self.cv2.COLOR_BGR2RGB))
                if not result.multi_face_landmarks or len(result.multi_face_landmarks) != 1:
                    return False
                landmarks.append(result.multi_face_landmarks[0].landmark)
                bbox = self.detector.get_bbox(image)
                if bbox[2] < 80 or bbox[3] < 80 or bbox[0] < 0 or bbox[1] < 0:
                    return False
                predictions = self.np.zeros((1, 3))
                for model in self.models:
                    h, w, _, scale = self.parser(model.name)
                    cropped = self.crop.crop(org_img=image, bbox=bbox, scale=scale,
                                             out_w=w, out_h=h, crop=scale is not None)
                    predictions += self.detector.predict(cropped, str(model))
                # Minivision class index 1 means 'real'; do not trust untuned scores.
                score = float(predictions[0, 1] / max(float(predictions.sum()), 1e-9))
                if int(predictions.argmax()) != 1 or score < self.threshold:
                    return False
            return active_sequence_meets_prompt(prompt, landmarks, yaw_sign=self.yaw_sign)


class PadHandler(BaseHTTPRequestHandler):
    evaluator = None
    secret = ""
    policy_id = ""
    reviewed = False
    seen = {}
    replay_lock = threading.Lock()

    def log_message(self, *_args):
        # Deliberately avoid logging biometric data, request paths or secrets.
        return

    def do_POST(self):
        self.connection.settimeout(5)
        if urlsplit(self.path).path != "/v1/presentation-verify":
            return self.respond(404)
        try:
            if int(self.headers.get("Content-Length", "0")) not in range(1, MAX_BODY + 1):
                return self.respond(413)
            raw = self.rfile.read(int(self.headers["Content-Length"]))
            if not self.reviewed or not self.evaluator:
                return self.respond(503)
            obj = validate_request(raw, self.secret, self.headers.get("x-eide-pad-request-signature", ""))
            key = obj["challengeId"] + ":" + obj["nonce"]
            with self.replay_lock:
                now = time.monotonic()
                for item, expiry in list(self.seen.items()):
                    if expiry < now:
                        del self.seen[item]
                if key in self.seen:
                    return self.respond(403)
                self.seen[key] = now + MAX_AGE
            if not self.evaluator.evaluate(obj["frames"], obj["prompt"]):
                return self.respond(403)
            digest = hashlib.sha256(raw).hexdigest()
            data = {
                "challengeId": obj["challengeId"], "nonce": obj["nonce"],
                "prompt": obj["prompt"], "requestDigest": digest,
                "passed": True, "captureBindingVerified": True,
                "policyId": self.policy_id,
            }
            data["signature"] = hex_hmac(self.secret, pad_signature_payload(data))
            return self.respond(200, data)
        except (ValueError, TypeError, UnicodeError, json.JSONDecodeError):
            return self.respond(403)
        except Exception:
            return self.respond(403)

    def respond(self, status, data=None):
        payload = json.dumps(data or {"error": "PAD rejected or unavailable"}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(payload)


def main():
    secret = os.getenv("EIDE_EXEC_PAD_SECRET", "")
    policy = os.getenv("EIDE_EXEC_PAD_POLICY_ID", "")
    if len(secret) < 32 or not 8 <= len(policy) <= 128:
        raise SystemExit("PAD signing configuration required")
    model_dir = os.getenv("MINIVISION_PAD_MODELS_DIR", "")
    repo = os.getenv("MINIVISION_PAD_REPO", "")
    reviewed = os.getenv("EIDE_PAD_INDEPENDENTLY_ASSESSED") == "1"
    # Deliberate NO-GO by default: an experimental RGB model is not proof of
    # camera hardware integrity or immunity to injection/deepfake attacks.
    if reviewed:
        if not Path(repo, "src/anti_spoof_predict.py").is_file() or not Path(model_dir).is_dir():
            raise SystemExit("Vetted PAD repository/model files are missing")
        score = float(os.getenv("MINIVISION_PAD_MIN_LIVE_SCORE", "0.85"))
        sign = int(os.getenv("MINIVISION_PAD_YAW_SIGN", "1"))
        if not 0.8 <= score <= 0.99 or sign not in (-1, 1):
            raise SystemExit("PAD threshold or camera orientation is unsafe")
        evaluator = OpenSourcePadEvaluator(repo, model_dir, score, sign)
    else:
        evaluator = None
    PadHandler.evaluator = evaluator
    PadHandler.secret = secret
    PadHandler.policy_id = policy
    PadHandler.reviewed = reviewed
    httpd = ThreadingHTTPServer(("0.0.0.0", int(os.getenv("EIDE_EXEC_PAD_PORT", "8092"))), PadHandler)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
