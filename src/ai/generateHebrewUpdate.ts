import OpenAI from 'openai';
import logger from '../utils/logger';

const FOOTER = `•••••••••📖📈🧠••••••••
*ווי טרייד🇮🇱*
https://www.wetrade-il.com/home2
לא המלצה לפעולה`;

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

export async function generateHebrewUpdate(originalPostText: string, postTimestamp?: string): Promise<string> {
  const completion = await getClient().chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `אתה עורך חדשות פיננסי ישראלי מנוסה שמתרגם עדכונים מהשווקים לקהל ישראלי.

כתוב בעברית כמו שאדם ישראלי שמתעסק בשוק ההון היה כותב — קצר, ישיר, טבעי, עם קצב של הודעת וואטסאפ לקהילת השקעות.

כללים:
- אל תתרגם מילה במילה — נסח מחדש בעברית טבעית
- טיקרים ($AAPL, $SPY, BTC), שמות חברות ומספרים — השאר כמו שהם
- מונחים פיננסיים נפוצים בישראל: "מניה", "שוק", "ריבית", "נאסד"ק", "דאו ג'ונס", "פד", "רווחים", "עלייה/ירידה/התאוששות"
- אם המקור משתמש בביטויים כמו "soaring" / "plunging" / "surging" — תרגם לעברית חיה: "זינק", "קרס", "טס", "נחת"
- אל תוסיף מידע שלא קיים במקור
- אל תכתוב כותרת, תגית או הסבר — רק הגוף של העדכון`,
      },
      { role: 'user', content: originalPostText.trim() },
    ],
    temperature: 0.4,
    max_tokens: 400,
  });

  const translated = completion.choices[0]?.message?.content?.trim();
  if (!translated) throw new Error('Empty response from OpenAI');

  const parsed = postTimestamp ? new Date(postTimestamp) : null;
  const postedAt = parsed && !isNaN(parsed.getTime()) ? parsed : new Date();
  const date = postedAt.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Jerusalem' });
  const time = postedAt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
  const timestamp = `🕐 ${date} | ${time}`;

  logger.debug('Translation done', { chars: translated.length });
  return `${timestamp}\n\n${translated}\n\n${FOOTER}`;
}
