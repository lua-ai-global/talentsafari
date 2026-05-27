import { LuaAgent } from 'lua-cli';
import { scoreRoleSkill } from './skills/score-role.skill.js';
import { captureLeadSkill } from './skills/capture-lead.skill.js';
import { submitCtaSkill } from './skills/submit-cta.skill.js';
import { adaChatSkill } from './skills/ada-chat.skill.js';
import { briefWizardSkill } from './skills/brief-wizard.skill.js';
import { scrapeJdSkill } from './skills/scrape-jd.skill.js';

const agent = new LuaAgent({
  name: 'Ada',
  persona: `# Ada - Persona

This is a starting template to help you think about your agent's persona.
Use it as-is, rearrange it, or replace it entirely with your own format — whatever works best for your use case.
The sections below are suggestions, not requirements.

## Identity & Role
Who is your agent? What's their name and core purpose?
- Give it a name and a clear one-line role
- e.g. a customer support rep, a shopping assistant, an internal ops copilot, a scheduling bot

## Business Context
What company, product, or service does the agent represent? What does the business do?
- Describe the business in a sentence or two so the agent understands the world it operates in
- Include industry, value proposition, and anything the agent should "know" about the brand

## Tone & Communication Style
How should the agent sound?
- Formal or casual? Concise or detailed? Empathetic or matter-of-fact?
- Should it match a specific brand voice or adapt to the user's tone?
- Any language or cultural considerations (e.g. greetings, local expressions)?

## Target Audience
Who will the agent be talking to?
- Describe the typical user: consumers, business customers, internal team members, etc.
- What do they usually need help with? What matters most to them?

## Capabilities
What can the agent help with? List the main things it should handle.
- e.g. answering product questions, placing orders, looking up account info, scheduling meetings
- Be specific — this shapes which skills and tools the agent will use

## Boundaries
What should the agent NOT do? When should it escalate to a human?
- e.g. cannot process refunds, should not give medical/legal advice
- Define when to hand off: frustrated user, request outside scope, sensitive data

## Guidelines
Any rules for how the agent behaves?
- Response length limits (e.g. keep messages under 300 words)
- Formatting preferences (e.g. use bullet points, avoid jargon)
- Things to always or never do (e.g. always confirm before changes, never share internal IDs)

---
Feel free to add, remove, or rename sections. Your persona can be a single paragraph or a detailed playbook — whatever gives your agent the context it needs.
`,
  model: 'anthropic/claude-sonnet-4-6',
  skills: [scoreRoleSkill, captureLeadSkill, submitCtaSkill, adaChatSkill, briefWizardSkill, scrapeJdSkill],
});

async function main() {}

main().catch(console.error);
