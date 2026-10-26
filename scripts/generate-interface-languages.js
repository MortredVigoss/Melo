import { readFile,writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
export async function generateInterfaceLanguages({check=false}={}) {
 const entries=JSON.parse(await readFile(resolve(root,'shared/protocol/interface-languages.json'),'utf8'));
 const quote=value=>JSON.stringify(value);
 const js='// Generated from shared/protocol/interface-languages.json.\nexport const LANGUAGES = Object.freeze('+JSON.stringify(entries.map(({id,name,short})=>({id,name,short})),null,2)+'.map(Object.freeze));\n';
 const swift=['// Generated from shared/protocol/interface-languages.json. Do not edit.',
 'import Foundation','','enum InterfaceLanguage: String, CaseIterable, Identifiable {',
 '    case '+entries.map(row=>row.swift+' = '+quote(row.id)).join(', '),
 '    var id: String { rawValue }',
 '    var name: String { switch self { '+entries.map(row=>'case .'+row.swift+': return '+quote(row.name)).join('; ')+' } }',
 '    var localeID: String { switch self { '+entries.map(row=>'case .'+row.swift+': return '+quote(row.locale)).join('; ')+' } }',
 '    static var system: Self { resolve(nil) }',
 '    static func resolve(_ value: String?, systemLanguage: String = Locale.current.identifier) -> Self {',
 '        func match(_ value: String) -> Self? {',
 '            let base = value.replacingOccurrences(of: "_", with: "-").split(separator: "-").first?.lowercased()',
 '            return allCases.first { $0.rawValue.split(separator: "-").first?.lowercased() == base }',
 '        }',
 '        return value.flatMap(match) ?? match(systemLanguage) ?? .english',
 '    }','}',''].join('\n');
 for(const [path,text] of [['desktop-ui/interfaceLanguages.js',js],['ios/Melo/InterfaceLanguage.swift',swift]]) {
  if(check) { if(await readFile(resolve(root,path),'utf8')!==text) throw new Error(path+' is stale'); }
  else await writeFile(resolve(root,path),text);
 }
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) await generateInterfaceLanguages({check:process.argv.includes('--check')});
