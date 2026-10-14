"""stdlib-only contract regression tests; these do NOT test biometric models."""
import base64
import hashlib
import importlib.util
import json
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path

module = Path(__file__).with_name('engine.py')
spec = importlib.util.spec_from_file_location('eide_pad_engine', module)
pad = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pad)
SECRET = 'PAD_TEST_SECRET_NO_REAL_CREDENTIAL_0123456789'
FRAME = b'\xff\xd8\xff' + b'v'*320

def request_payload():
    return {'challengeId':str(uuid.uuid4()), 'nonce':'n'*44, 'prompt':'turn_left',
            'frames':[base64.b64encode(FRAME+bytes([i])).decode() for i in range(3)]}

class PadSecurityTests(unittest.TestCase):
    def test_signature_and_request_bound(self):
        obj=request_payload()
        raw=json.dumps(obj, separators=(',',':')).encode()
        good=pad.hex_hmac(SECRET,raw.decode())
        self.assertEqual(pad.validate_request(raw,SECRET,good), obj)
        with self.assertRaises(ValueError):
            pad.validate_request(raw, SECRET,'0'*64)
        obj['frames'][2]=obj['frames'][0]
        dup=json.dumps(obj,separators=(',',':')).encode()
        with self.assertRaises(ValueError):
            pad.validate_request(dup, SECRET,pad.hex_hmac(SECRET,dup.decode()))

    def test_mocked_http_denies_unauthenticated_and_replay(self):
        class Evaluator:
            def evaluate(self,frames,prompt):
                return prompt == 'turn_left'
        class Handler(pad.PadHandler):
            evaluator=Evaluator()
            secret=SECRET
            policy_id='test-only-policy'
            reviewed=True
            seen={}
        srv=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=srv.serve_forever,daemon=True).start()
        url=f'http://127.0.0.1:{srv.server_port}/v1/presentation-verify'
        def send(body, signature):
            try:
                with urllib.request.urlopen(urllib.request.Request(url,body,
                    {'Content-Type':'application/json','x-eide-pad-request-signature':signature}),timeout=3) as r:
                    return r.status,json.load(r)
            except urllib.error.HTTPError as err:
                return err.code,None
        try:
            obj=request_payload()
            raw=json.dumps(obj,separators=(',',':')).encode()
            sig=pad.hex_hmac(SECRET,raw.decode())
            self.assertEqual(send(raw,'0'*64)[0],403)
            code,response=send(raw,sig)
            self.assertEqual(code,200)
            self.assertEqual(response['signature'],pad.hex_hmac(SECRET,pad.pad_signature_payload(response)))
            self.assertEqual(response['requestDigest'],hashlib.sha256(raw).hexdigest())
            self.assertEqual(send(raw,sig)[0],403)
        finally:
            srv.shutdown();srv.server_close()

    def test_active_challenge_rejects_stationary_head_and_neutral_eyes(self):
        from types import SimpleNamespace
        def face(nose=0.5, eyelid=0.11):
            p=[SimpleNamespace(x=0.5,y=0.5) for _ in range(468)]
            for i,x in ((234,0.0),(454,1.0),(1,nose),(33,0.0),(133,1.0),
                        (362,0.0),(263,1.0)):
                p[i]=SimpleNamespace(x=x,y=0.5)
            for i,x in ((160,0.3),(158,0.7),(385,0.3),(387,0.7)):
                p[i]=SimpleNamespace(x=x,y=0.5+eyelid)
            for i,x in ((153,0.7),(144,0.3),(373,0.7),(380,0.3)):
                p[i]=SimpleNamespace(x=x,y=0.5-eyelid)
            return p
        neutral=face(); changed=face(nose=0.72)
        self.assertFalse(pad.active_sequence_meets_prompt('turn_right',[neutral,neutral,neutral]))
        self.assertFalse(pad.active_sequence_meets_prompt('blink',[neutral,neutral,neutral]))
        self.assertTrue(pad.active_sequence_meets_prompt('turn_right',[neutral,changed,neutral]))
        self.assertFalse(pad.active_sequence_meets_prompt('turn_left',[neutral,changed,neutral]))
        self.assertTrue(pad.active_sequence_meets_prompt('blink',[neutral,face(eyelid=0.02),neutral]))

    def test_default_research_service_refuses_positive_attestations(self):
        class Handler(pad.PadHandler):
            evaluator=None
            reviewed=False
            secret=SECRET
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        try:
            obj=request_payload();raw=json.dumps(obj).encode()
            req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/v1/presentation-verify',raw,
                {'x-eide-pad-request-signature':pad.hex_hmac(SECRET,raw.decode())})
            with self.assertRaises(urllib.error.HTTPError) as cm:
                urllib.request.urlopen(req,timeout=3)
            self.assertEqual(cm.exception.code,503)
        finally:
            server.shutdown();server.server_close()

if __name__ == '__main__':
    unittest.main()
