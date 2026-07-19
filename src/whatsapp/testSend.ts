/**
 * Deep diagnostic for empty WhatsApp Store after ready.
 * Stop the bot first, then: npm run wa:test
 */
import 'dotenv/config';
import client, { isClientReady } from './waClient';
import { sendToWhatsappGroup } from './sendWhatsappGroup';

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  console.log('Starting WhatsApp client...');
  await client.initialize();

  const deadline = Date.now() + 90_000;
  while (!isClientReady() && Date.now() < deadline) {
    await sleep(500);
  }
  if (!isClientReady()) {
    console.error('WhatsApp not ready in time');
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const info = (client as any).info;
  console.log('Linked account info:', JSON.stringify(info ?? null, null, 2));

  const page = (client as unknown as { pupPage: { evaluate: Function } }).pupPage;

  for (let attempt = 1; attempt <= 6; attempt++) {
    console.log(`\n--- Sync probe ${attempt}/6 ---`);
    const dump = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      const storeKeys = w.Store ? Object.keys(w.Store).slice(0, 40) : [];
      const chatModels = w.Store?.Chat?.getModelsArray?.() ?? [];
      const chatLen = w.Store?.Chat?.length ?? w.Store?.Chat?._models?.length ?? null;
      let wwebChats: number | string = 'n/a';
      try {
        // may be async in some builds
      } catch (e) {
        wwebChats = String(e);
      }
      return {
        hasStore: !!w.Store,
        hasWWebJS: !!w.WWebJS,
        storeKeys,
        chatModels: chatModels.length,
        chatLen,
        conn: {
          isMainReady: w.Store?.Conn?.isMainReady,
          isPhoneConnected: w.Store?.Conn?.isPhoneConnected,
          ref: w.Store?.Conn?.ref,
        },
        wid: w.Store?.Conn?.wid?._serialized || w.Store?.User?.wid?._serialized || null,
        sample: chatModels.slice(0, 10).map((c: { name?: string; formattedTitle?: string; isGroup?: boolean; id?: { _serialized?: string } }) => ({
          name: c.name || c.formattedTitle || '(no name)',
          isGroup: !!c.isGroup,
          id: c.id?._serialized || '',
        })),
        wwebChats,
        url: location.href,
        title: document.title,
      };
    });
    console.log(JSON.stringify(dump, null, 2));

    if ((dump.chatModels as number) > 0) break;
    await sleep(5_000);
  }

  // Try invite join to force a chat into Store
  const invite = (process.env.WHATSAPP_GROUP_INVITE_URL || '').match(
    /chat\.whatsapp\.com\/([A-Za-z0-9]+)/,
  )?.[1];
  if (invite) {
    console.log('\nTrying getInviteInfo / acceptInvite...', invite);
    try {
      const infoInvite = await client.getInviteInfo(invite);
      console.log('Invite info:', JSON.stringify(infoInvite, null, 2));
    } catch (e) {
      console.log('getInviteInfo error:', (e as Error).message);
    }
    try {
      const gid = await client.acceptInvite(invite);
      console.log('acceptInvite returned:', gid);
    } catch (e) {
      console.log('acceptInvite error:', (e as Error).message);
    }
    await sleep(5_000);
    const after = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any;
      const models = w.Store?.Chat?.getModelsArray?.() ?? [];
      return {
        chatModels: models.length,
        groups: models
          .filter((c: { isGroup?: boolean }) => c.isGroup)
          .map((c: { name?: string; id?: { _serialized?: string } }) => ({
            name: c.name,
            id: c.id?._serialized,
          })),
      };
    });
    console.log('After invite:', JSON.stringify(after, null, 2));
  }

  try {
    const chats = await client.getChats();
    console.log('client.getChats() count:', chats.length);
  } catch (e) {
    console.log('client.getChats() error:', (e as Error).message);
  }

  const result = await sendToWhatsappGroup('🧪 בדיקת שליחה מהבוט\nלא המלצה לפעולה');
  console.log('Send result:', result);

  await client.destroy().catch(() => undefined);
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
