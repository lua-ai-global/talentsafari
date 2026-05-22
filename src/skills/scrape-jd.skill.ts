import { LuaSkill, LuaTool } from 'lua-cli';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const scrapeJdInputSchema = z.object({
  url: z.string().url().describe('URL of a job posting page'),
});

type ScrapeJdInput = z.infer<typeof scrapeJdInputSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJdFromHtml(html: string): string {
  // Strip scripts, styles, nav, header, footer
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Return up to 6000 chars — enough for any JD
  return stripped.slice(0, 6000);
}

function extractOtherRoles(html: string): string[] {
  // Look for job title patterns in anchor text
  const matches = [...html.matchAll(/<a[^>]*>([^<]{10,80})<\/a>/gi)]
    .map((m) => m[1].trim())
    .filter((t) => /\b(engineer|manager|director|analyst|designer|developer|lead|head of|specialist|coordinator|officer)\b/i.test(t))
    .slice(0, 5);
  return [...new Set(matches)];
}

// ---------------------------------------------------------------------------
// Tool — class-based pattern (required for lua-cli AST scanner detection)
// ---------------------------------------------------------------------------

export class scrapeJdTool implements LuaTool<typeof scrapeJdInputSchema> {
  name = 'scrape_jd';
  description =
    'Fetch a job posting URL, extract the job description text using Claude Haiku, and best-effort collect other open roles from the same company careers page.';
  inputSchema = scrapeJdInputSchema;

  async execute(input: ScrapeJdInput): Promise<unknown> {
    const { url } = input;

    // Step 1: Fetch the job posting page
    let html: string;
    try {
      const pageResponse = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });

      if (!pageResponse.ok) {
        return { error: 'Could not fetch that URL. Try pasting the JD text directly.' };
      }

      html = await pageResponse.text();
    } catch {
      return { error: 'Could not fetch that URL. Try pasting the JD text directly.' };
    }

    // Step 2: Extract job description via Haiku
    let jdText: string;
    try {
      jdText = await extractJdFromHtml(html);
    } catch {
      return { error: 'Could not fetch that URL. Try pasting the JD text directly.' };
    }

    if (!jdText || jdText === 'NOT_FOUND') {
      return {
        error: 'Could not find a job description at that URL. Try pasting the text directly.',
      };
    }

    // Step 3: Best-effort — try fetching the careers page for other roles
    let otherRoles: string[] = [];
    try {
      const parsed = new URL(url);
      const careersUrl = `${parsed.origin}/careers`;

      const careersResponse = await fetch(careersUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
      });

      if (careersResponse.ok) {
        const careersHtml = await careersResponse.text();
        otherRoles = await extractOtherRoles(careersHtml);
      }
    } catch {
      // Silently ignore — best-effort only
    }

    return { jdText, otherRoles };
  }
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

export const scrapeJdSkill = new LuaSkill({
  name: 'scrape-jd',
  description:
    'Fetches a job posting URL, extracts the job description text using Claude Haiku, and optionally surfaces other open roles from the same company careers page.',
  context: `Use the scrape_jd tool when a user provides a URL to a job posting and wants to score it without copy-pasting the text.

The tool:
1. Fetches the URL with a browser-like User-Agent.
2. Sends the raw HTML (up to 15,000 characters) to Claude Haiku to extract only the job title and description text — no navigation, no boilerplate.
3. Makes a best-effort request to {origin}/careers to extract up to 5 other open role titles from the same company.

Returns:
  { jdText: string, otherRoles: string[] } on success.
  { error: string } if the page couldn't be fetched or no JD was found.

On success, pass jdText directly into score_jd as the jdText input. otherRoles is optional context — display it to the user if present so they can explore other roles.`,
  tools: [new scrapeJdTool()],
});
