import { writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const attachmentOne = `合成付款资料（演练专用，不对应任何真实金融账户）
单据编号：PAY-SYN-001
收款方：演练收款方甲（合成主体）
用途：合作资料核验演练
金额（小写）：100.00
制单：maker-A
`;
const attachmentTwo = `合成付款资料（演练专用，不对应任何真实金融账户）
单据编号：PAY-SYN-002
收款方：演练收款方甲（合成主体）
用途：合作资料核验演练——金额修订
金额（小写）：100.00
制单：maker-A
备注：本附件为同一笔业务的修订版本，用于演示复核版本绑定。
`;

await mkdir('fixtures/attachments', { recursive: true });
await writeFile('fixtures/attachments/付款资料-SYN-001.txt', attachmentOne, { mode: 0o600 });
await writeFile('fixtures/attachments/付款资料-SYN-002-修订版.txt', attachmentTwo, { mode: 0o600 });

const state = {
  users: [
    { id: 'maker-A', name: '制单员甲', role: 'maker' },
    { id: 'reviewer-B', name: '复核员乙', role: 'reviewer' },
  ],
  payment: {
    id: 'PAY-SYN-001',
    amount: 100,
    purpose: '合作资料核验演练',
    version: 1,
    maker: 'maker-A',
    approved: false,
    attachment: {
      name: '付款资料-SYN-001.txt',
      path: 'fixtures/attachments/付款资料-SYN-001.txt',
      sha256: digest(Buffer.from(attachmentOne)),
    },
  },
  opinions: [],
};
await writeFile('fixtures/state.json', JSON.stringify(state, null, 2));
await writeFile(
  'fixtures/portal.json',
  JSON.stringify(
    {
      title: '双人复核门户的角色隔离自动化',
      local: true,
      roles: ['人工使用者'],
      entry: '/',
      scenario: 'separated-approval',
    },
    null,
    2,
  ),
);
await writeFile('fixtures/certificate.txt', '合成检测证明：SYN-001\n');
