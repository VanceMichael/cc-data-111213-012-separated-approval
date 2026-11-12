import {writeFile,mkdir} from 'node:fs/promises';
await mkdir('fixtures',{recursive:true});
await writeFile('fixtures/state.json',JSON.stringify({"users": [{"id": "maker-A", "name": "制单员甲", "role": "maker"}, {"id": "reviewer-B", "name": "复核员乙", "role": "reviewer"}], "payment": {"amount": 100, "version": 1, "maker": "maker-A", "approved": false}},null,2));
await writeFile('fixtures/portal.json',JSON.stringify({"title": "双人复核门户的角色隔离自动化", "local": true, "roles": ["人工使用者"], "entry": "/", "scenario": "separated-approval"},null,2));
await writeFile('fixtures/certificate.txt','合成检测证明：SYN-001\n');
