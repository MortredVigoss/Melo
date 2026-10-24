import test from 'node:test';
import { generateInterfaceLanguages } from './generate-interface-languages.js';
test('desktop and iPhone use the same authored interface language catalog',async()=>{await generateInterfaceLanguages({check:true});});
