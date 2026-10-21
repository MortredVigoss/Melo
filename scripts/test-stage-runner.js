import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// Store complete logs without feeding thousands of passing assertions back
// into the terminal/agent context. Never cache success or retry failures.
export async function createStageRunner({root = process.cwd(), env = {...process.env}, emit = console.log} = {}) {
  const parent = resolve(root, '.tmp/test-runs');
  await mkdir(parent, {recursive:true});
  const directory = await mkdtemp(join(parent, 'run-'));
  const records = [];
  return {
    directory,
    async run(label, command, args) {
      const started = Date.now();
      const log = join(directory, `${records.length + 1}.log`);
      const handle = await open(log, 'w+');
      let tail = '';
      emit(`▶ ${label}`);
      let code;
      try {
        code = await new Promise((accept, reject) => {
          const child = spawn(command, args, {cwd:root, env, stdio:['ignore',handle.fd,handle.fd]});
          child.once('error', reject); child.once('close', value => accept(value ?? 1));
        });
      } catch (error) {
        code = 1; tail += `\n${error.message}`;
      } finally {
        if(code) {
          const size=(await handle.stat()).size;
          const buffer=Buffer.alloc(Math.min(size,12000));
          await handle.read(buffer,0,buffer.length,Math.max(0,size-buffer.length));
          tail=buffer.toString()+tail;
        }
        await handle.close();
      }
      records.push({label, command, args, code, seconds:(Date.now()-started)/1000, log});
      await writeFile(join(directory,'report.json'), JSON.stringify({records},null,2)+'\n');
      emit(`${code ? '✗' : '✓'} ${label} ${records.at(-1).seconds.toFixed(2)}s · ${log}`);
      if(code) { emit(tail); throw Error(`${label} failed (${code})`); }
    },
  };
}
