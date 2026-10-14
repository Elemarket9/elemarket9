/** Operator-run connectivity probe. No face template created or stored. */
import { readFile } from 'node:fs/promises';
import { providerConfig } from './compreface.mjs';
const path=process.argv[2];
if (!path) { console.error('Usage: node integrations/executive-face/smoke-test.mjs /path/to/non-sensitive-test-face.jpg');process.exit(2); }
try {
  const cfg=providerConfig(process.env);
  const bytes=await readFile(path);
  if (bytes.length>2_000_000 || bytes.length<100 || bytes[0]!==0xff || bytes[1]!==0xd8) throw Error('Expected a JPEG smaller than 2MB');
  const response=await fetch(`${cfg.baseUrl}/api/v1/recognition/recognize?limit=0&prediction_count=1`,{
    method:'POST',headers:{'x-api-key':cfg.key,'content-type':'application/json'},
    body:JSON.stringify({file:bytes.toString('base64')}),redirect:'error',signal:AbortSignal.timeout(12000),
  });
  if(!response.ok)throw Error(`CompreFace returned status ${response.status}`);
  const result=await response.json();
  if(!Array.isArray(result?.result))throw Error('Unexpected CompreFace response');
  console.log(`CompreFace API reachable; detected faces: ${result.result.length}. No enrollment performed.`);
} catch(e) {console.error('CompreFace connection check failed:',e.message);process.exitCode=1;}
