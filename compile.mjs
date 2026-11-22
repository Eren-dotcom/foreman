import { compileFile } from 'cashc';
import fs from 'fs';
const artifact = compileFile(new URL('./contracts/ChunkPod.cash', import.meta.url));
fs.mkdirSync('./artifacts', { recursive: true });
fs.writeFileSync('./artifacts/ChunkPod.json', JSON.stringify(artifact, null, 2));
console.log('compiled OK. opcodes:', artifact.bytecode.length/2, 'bytes');
