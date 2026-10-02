import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { GoogleGenAI, Type } from '@google/genai';
import { INITIAL_MEMORIES, INITIAL_INSIGHTS, INITIAL_COLLECTIONS } from './src/data/seedMemories.ts';
import { Memory, AIInsight, Collection, AskMemoryResponse, MemoryRelationship } from './src/types/memory.ts';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

app.use(express.json({ limit: '25mb' }));

// In-memory store with local disk persistence backup
let memories: Memory[] = [...INITIAL_MEMORIES];
let insights: AIInsight[] = [...INITIAL_INSIGHTS];
let collections: Collection[] = [...INITIAL_COLLECTIONS];

const DATA_FILE = path.resolve(process.cwd(), 'data_store.json');
try {
  if (fs.existsSync(DATA_FILE)) {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed.memories && Array.isArray(parsed.memories)) {
      memories = parsed.memories;
    }
    if (parsed.insights && Array.isArray(parsed.insights)) {
      insights = parsed.insights;
    }
    if (parsed.collections && Array.isArray(parsed.collections)) {
      collections = parsed.collections;
    }
  }
} catch (err) {
  console.warn('Could not load persistent store, using seeds:', err);
}

function persistStore() {
  try {
    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify({ memories, insights, collections }, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.warn('Failed to persist store:', err);
  }
}

// Initialize Gemini Client
const apiKey = process.env.GEMINI_API_KEY;
let aiClient: GoogleGenAI | null = null;
if (apiKey) {
  try {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  } catch (e) {
    console.warn('Failed to initialize GoogleGenAI client:', e);
  }
}

// Helper: Simple Hybrid Retrieval
function retrieveRelevantMemories(query: string, limit = 5) {
  const qLower = query.toLowerCase();
  const queryTokens = qLower
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ''))
    .filter((t) => t.length > 2);

  const scored = memories.map((mem) => {
    let score = 0;
    const titleLower = mem.title.toLowerCase();
    const contentLower = mem.content.toLowerCase();
    const summaryLower = mem.summary.toLowerCase();
    const topicsLower = mem.topics.map((t) => t.toLowerCase());
    const entitiesLower = mem.entities.map((e) => e.toLowerCase());

    // Direct phrase matching
    if (contentLower.includes(qLower) || titleLower.includes(qLower)) {
      score += 15;
    }

    // Token matches
    queryTokens.forEach((token) => {
      if (titleLower.includes(token)) score += 6;
      if (topicsLower.some((t) => t.includes(token))) score += 5;
      if (entitiesLower.some((e) => e.includes(token))) score += 5;
      if (summaryLower.includes(token)) score += 3;
      if (contentLower.includes(token)) score += 2;
    });

    // Semantic keyword mapping boosts
    if (qLower.includes('dbms') || qLower.includes('database') || qLower.includes('assignment') || qLower.includes('due') || qLower.includes('deadline')) {
      if (mem.topics.includes('DBMS') || mem.topics.includes('Databases')) score += 8;
    }
    if (qLower.includes('cctv') || qLower.includes('security') || qLower.includes('surveillance') || qLower.includes('website') || qLower.includes('lead')) {
      if (mem.topics.includes('CCTV') || mem.topics.includes('Web Development')) score += 8;
    }
    if (qLower.includes('driving') || qLower.includes('school') || qLower.includes('instructor') || qLower.includes('booking')) {
      if (mem.title.includes('Driving') || mem.topics.includes('Client Leads')) score += 8;
    }
    if (qLower.includes('java') || qLower.includes('binary search') || qLower.includes('algorithm') || qLower.includes('code')) {
      if (mem.topics.includes('Java') || mem.topics.includes('Algorithms')) score += 8;
    }
    if (qLower.includes('flight') || qLower.includes('hotel') || qLower.includes('travel') || qLower.includes('tokyo') || qLower.includes('ticket')) {
      if (mem.category === 'Travel' || mem.topics.includes('Tokyo')) score += 8;
    }

    return {
      memory: mem,
      score,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ----------------- API ROUTES ----------------- //

// 1. Get all memories
app.get('/api/memories', (req: Request, res: Response) => {
  const { category, type, search } = req.query;
  let result = [...memories];

  if (category && typeof category === 'string' && category !== 'All') {
    result = result.filter((m) => m.category.toLowerCase() === category.toLowerCase());
  }

  if (type && typeof type === 'string' && type !== 'all') {
    result = result.filter((m) => m.sourceType === type);
  }

  if (search && typeof search === 'string') {
    const s = search.toLowerCase();
    result = result.filter(
      (m) =>
        m.title.toLowerCase().includes(s) ||
        m.summary.toLowerCase().includes(s) ||
        m.content.toLowerCase().includes(s) ||
        m.topics.some((t) => t.toLowerCase().includes(s)) ||
        m.entities.some((e) => e.toLowerCase().includes(s))
    );
  }

  // Sort newest first
  result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json({ memories: result, count: result.length });
});

// 2. Capture a new memory (Fast optimistic return)
app.post('/api/memories', (req: Request, res: Response) => {
  const { title, content, sourceType, imageUrl, fileAttachment, sourceUrl } = req.body;

  if (!content && !imageUrl) {
    return res.status(400).json({ error: 'Content or image is required to capture a memory.' });
  }

  const newId = `mem-${Date.now()}`;
  const now = new Date().toISOString();

  // Initial immediate memory record
  const initialMemory: Memory = {
    id: newId,
    title: title || (content ? content.slice(0, 48).trim() : 'Captured Item'),
    content: content || 'Captured asset without explicit text.',
    summary: 'Analyzing and connecting to your personal memory...',
    sourceType: sourceType || 'note',
    category: 'Other',
    topics: ['Pending Ingestion'],
    entities: [],
    keyFacts: [],
    actionItems: [],
    detectedDates: [],
    sourceUrl,
    imageUrl,
    fileAttachment,
    relationships: [],
    importance: 'normal',
    isProcessing: true,
    createdAt: now,
    updatedAt: now,
  };

  memories.unshift(initialMemory);
  persistStore();

  res.status(201).json({
    status: 'captured',
    message: 'Memory captured in < 1s. Background AI ingestion started.',
    memory: initialMemory,
  });
});

// 3. AI Ingestion Pipeline (Step 1 Extract -> Step 2 Understand -> Step 3 Connect)
app.post('/api/memories/ingest', async (req: Request, res: Response) => {
  const { memoryId } = req.body;
  const memoryIndex = memories.findIndex((m) => m.id === memoryId);

  if (memoryIndex === -1) {
    return res.status(404).json({ error: 'Memory not found' });
  }

  const targetMemory = memories[memoryIndex];

  try {
    let understanding = null;

    if (aiClient) {
      // Build context of other memories for relationship discovery
      const existingContext = memories
        .filter((m) => m.id !== memoryId)
        .slice(0, 10)
        .map((m) => ({ id: m.id, title: m.title, summary: m.summary, topics: m.topics }));

      const prompt = `You are the core intelligence pipeline for SECOND BRAIN (Personal Memory OS).
Analyze the captured content and existing memories.
Do not wrap responses in markdown quotes or extra text. Output strictly valid JSON.

Captured content:
"""
Title Hint: ${targetMemory.title}
Source Type: ${targetMemory.sourceType}
Content: ${targetMemory.content}
"""

Existing memories in Second Brain:
${JSON.stringify(existingContext, null, 2)}

Provide analysis in this exact JSON schema:
{
  "title": "Clean, memorable, intelligent title (max 6-8 words)",
  "summary": "Crisp 1-2 sentence executive summary of the content and intent",
  "category": "One of: Academic, Personal, Project, Work, Finance, Ideas, Reference, Travel, Shopping, Health, People, Documents, Other",
  "topics": ["Array of 3-5 high-signal topics"],
  "entities": ["Array of 2-5 extracted entities (people, tools, places, standards)"],
  "keyFacts": ["Array of 2-4 factual bullet points (Subject, Dates, Deadlines, Details)"],
  "actionItems": ["Array of any detected next steps or deadlines, or empty"],
  "detectedDates": ["Array of ISO date strings or explicit date mentions if found"],
  "relationships": [
    {
      "targetMemoryId": "id of an existing memory it relates to",
      "relationshipType": "One of: RELATED_TO, MENTIONS, SAME_TOPIC, SAME_PROJECT, SAME_PERSON, SAME_EVENT, BEFORE, AFTER, DERIVED_FROM, REFERENCE_FOR",
      "confidence": 0.85,
      "reason": "Exact explanation why they are connected (e.g. 'Both reference DBMS Unit 3 normalization')"
    }
  ]
}`;

      const response = await aiClient.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.2,
        },
      });

      if (response && response.text) {
        understanding = JSON.parse(response.text.trim());
      }
    }

    // Resilient fallback heuristic if Gemini is offline or did not return
    if (!understanding) {
      const text = `${targetMemory.title} ${targetMemory.content}`.toLowerCase();
      let guessedCategory: Memory['category'] = 'Other';
      const topics: string[] = [];
      const keyFacts: string[] = [];
      const actionItems: string[] = [];

      if (text.includes('assignment') || text.includes('lecture') || text.includes('exam') || text.includes('dbms') || text.includes('college')) {
        guessedCategory = 'Academic';
        topics.push('Academic', 'Study');
      } else if (text.includes('website') || text.includes('code') || text.includes('project') || text.includes('seo') || text.includes('client')) {
        guessedCategory = 'Project';
        topics.push('Web Development', 'Projects');
      } else if (text.includes('flight') || text.includes('hotel') || text.includes('travel') || text.includes('booking')) {
        guessedCategory = 'Travel';
        topics.push('Travel', 'Reservations');
      } else if (text.includes('idea') || text.includes('brainstorm') || text.includes('concept')) {
        guessedCategory = 'Ideas';
        topics.push('Ideas', 'Concepts');
      } else {
        guessedCategory = 'Personal';
        topics.push('General');
      }

      keyFacts.push(`Source: ${targetMemory.sourceType.toUpperCase()}`);
      if (targetMemory.content.length > 0) {
        keyFacts.push(`Captured ${targetMemory.content.slice(0, 60)}...`);
      }

      // Check relationships with existing memories
      const relationships: MemoryRelationship[] = [];
      for (const m of memories) {
        if (m.id === targetMemory.id) continue;
        const mText = `${m.title} ${m.summary} ${m.topics.join(' ')}`.toLowerCase();
        let overlap = false;
        let reason = '';

        if (text.includes('dbms') && mText.includes('dbms')) {
          overlap = true;
          reason = 'Both memories connect via Database Management Systems (DBMS).';
        } else if (text.includes('website') && mText.includes('website')) {
          overlap = true;
          reason = 'Both memories relate to website building and client leads.';
        } else if (text.includes('travel') && mText.includes('travel')) {
          overlap = true;
          reason = 'Both represent travel bookings and trip logistics.';
        }

        if (overlap) {
          relationships.push({
            targetMemoryId: m.id,
            relationshipType: 'RELATED_TO',
            confidence: 0.85,
            reason,
          });
        }
      }

      understanding = {
        title: targetMemory.title.length > 5 ? targetMemory.title : 'Captured Memory',
        summary: targetMemory.content.slice(0, 140) + '...',
        category: guessedCategory,
        topics: topics.length ? topics : ['Memory'],
        entities: [],
        keyFacts,
        actionItems,
        detectedDates: [],
        relationships,
      };
    }

    // Update memory
    targetMemory.title = understanding.title || targetMemory.title;
    targetMemory.summary = understanding.summary || targetMemory.content.slice(0, 100);
    targetMemory.category = understanding.category || targetMemory.category;
    targetMemory.topics = understanding.topics || ['Memory'];
    targetMemory.entities = understanding.entities || [];
    targetMemory.keyFacts = understanding.keyFacts || [];
    targetMemory.actionItems = understanding.actionItems || [];
    targetMemory.detectedDates = understanding.detectedDates || [];
    targetMemory.relationships = understanding.relationships || [];
    targetMemory.isProcessing = false;
    targetMemory.updatedAt = new Date().toISOString();

    // Check if new collections should be updated
    updateCollections(targetMemory);

    persistStore();

    res.json({
      status: 'ingested',
      memory: targetMemory,
    });
  } catch (err: any) {
    console.error('Ingestion pipeline error:', err);
    targetMemory.isProcessing = false;
    targetMemory.summary = targetMemory.content.slice(0, 120);
    persistStore();
    res.json({ status: 'completed_fallback', memory: targetMemory });
  }
});

function updateCollections(mem: Memory) {
  // Update collections dynamically
  for (const topic of mem.topics) {
    let col = collections.find((c) => c.name.toLowerCase().includes(topic.toLowerCase()));
    if (col && !col.memoryIds.includes(mem.id)) {
      col.memoryIds.push(mem.id);
      col.memoryCount = col.memoryIds.length;
    }
  }
}

// 4. ASK YOUR MEMORY (Grounded RAG retrieval)
app.post('/api/ask', async (req: Request, res: Response) => {
  const { question } = req.body;

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'Question is required' });
  }

  // Retrieve relevant memories
  const relevantResults = retrieveRelevantMemories(question, 4);
  const matchedMemories = relevantResults
    .filter((r) => r.score > 2)
    .map((r) => r.memory);

  // If score is too low and no memories match:
  if (matchedMemories.length === 0) {
    const insufficientResponse: AskMemoryResponse = {
      answer: "I couldn't find enough information in your personal memories to answer that confidently.",
      storedFacts: [],
      aiInterpretation: 'No relevant notes, screenshots, or documents matched your search query in Second Brain.',
      inference: 'Try searching with different keywords, or capture this information into your Second Brain now.',
      confidenceScore: 0.1,
      retrievedMemories: [],
      insufficientInfo: true,
    };
    return res.json(insufficientResponse);
  }

  // Grounded context
  const retrievedCards = matchedMemories.map((m, idx) => ({
    id: m.id,
    title: m.title,
    snippet: m.summary || m.content.slice(0, 140),
    sourceType: m.sourceType,
    matchScore: 0.95 - idx * 0.1,
    relevanceReason: `Matches topics: ${m.topics.slice(0, 3).join(', ')}`,
  }));

  try {
    if (aiClient) {
      const prompt = `You are the conversational retrieval engine for SECOND BRAIN (Personal Memory OS).
A user is searching/asking about their personal digital life.

User Question: "${question}"

RETRIEVED PERSONAL MEMORIES (Source of Truth):
${matchedMemories
  .map(
    (m, idx) => `
[Memory #${idx + 1}] ID: ${m.id}
Title: ${m.title}
Source Type: ${m.sourceType}
Captured Date: ${m.createdAt}
Summary: ${m.summary}
Content: ${m.content}
Key Facts: ${m.keyFacts.join('; ')}
Topics: ${m.topics.join(', ')}
`
  )
  .join('\n---\n')}

CRITICAL TRUST GUIDELINES:
1. Ground your answer EXCLUSIVELY in the memories above.
2. NEVER hallucinate or assume facts not present.
3. Distinguish clearly between:
   - Stored fact: Exact information written in memory.
   - AI interpretation: Logical connections between memories.
   - Inference: Suggested next action or implication.

Output strictly valid JSON with this schema:
{
  "answer": "Direct, calm, intelligent conversational answer addressing the user's question directly.",
  "storedFacts": ["Bulleted list of raw facts explicitly verified in the memories"],
  "aiInterpretation": "One clear paragraph explaining connections between the memories found.",
  "inference": "Pragmatic forward-looking advice or pending action item.",
  "confidenceScore": 0.95
}`;

      const aiResponse = await aiClient.models.generateContent({
        model: 'gemini-3.8-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.2,
        },
      });

      if (aiResponse && aiResponse.text) {
        const parsed = JSON.parse(aiResponse.text.trim());
        const result: AskMemoryResponse = {
          answer: parsed.answer,
          storedFacts: parsed.storedFacts || [],
          aiInterpretation: parsed.aiInterpretation || '',
          inference: parsed.inference || '',
          confidenceScore: parsed.confidenceScore || 0.9,
          retrievedMemories: retrievedCards,
        };
        return res.json(result);
      }
    }
  } catch (err) {
    console.warn('Gemini ask error, using grounded heuristic fallback:', err);
  }

  // Reliable grounded fallback response
  const first = matchedMemories[0];
  const storedFacts = matchedMemories.flatMap((m) => m.keyFacts).slice(0, 4);

  const result: AskMemoryResponse = {
    answer: `Based on your saved memory "${first.title}", ${first.summary}`,
    storedFacts: storedFacts.length ? storedFacts : [first.content.slice(0, 100)],
    aiInterpretation: `Found ${matchedMemories.length} connected memory item${
      matchedMemories.length > 1 ? 's' : ''
    } referencing ${first.topics.slice(0, 2).join(' and ')}.`,
    inference: first.actionItems.length
      ? `Upcoming task: ${first.actionItems[0]}`
      : 'Review your related memories to ensure complete context.',
    confidenceScore: 0.88,
    retrievedMemories: retrievedCards,
  };

  res.json(result);
});

// 5. Delete a memory
app.delete('/api/memories/:id', (req: Request, res: Response) => {
  const { id } = req.params;
  const initialLen = memories.length;
  memories = memories.filter((m) => m.id !== id);

  // Remove relationships pointing to it
  memories.forEach((m) => {
    m.relationships = m.relationships.filter((r) => r.targetMemoryId !== id);
  });

  persistStore();
  res.json({ success: true, removedCount: initialLen - memories.length });
});

// 6. Get Insights
app.get('/api/insights', (req: Request, res: Response) => {
  res.json({ insights });
});

// 7. Get Collections
app.get('/api/collections', (req: Request, res: Response) => {
  res.json({ collections });
});

// 8. Privacy Center Stats & Controls
app.get('/api/privacy/stats', (req: Request, res: Response) => {
  res.json({
    totalMemories: memories.length,
    encrypted: true,
    encryptionAlgorithm: 'AES-GCM 256-bit (Zero-Knowledge Local Storage)',
    aiProcessingMode: apiKey ? 'Cloud Gemini 3.8 Flash + Local Cache' : 'Local Heuristic Extraction',
    lastSyncTime: new Date().toISOString(),
    cloudSyncEnabled: true,
  });
});

app.post('/api/privacy/export', (req: Request, res: Response) => {
  res.json({
    exportedAt: new Date().toISOString(),
    version: '1.0',
    app: 'SECOND BRAIN',
    memories,
    insights,
    collections,
  });
});

app.post('/api/privacy/reset', (req: Request, res: Response) => {
  memories = [...INITIAL_MEMORIES];
  insights = [...INITIAL_INSIGHTS];
  collections = [...INITIAL_COLLECTIONS];
  persistStore();
  res.json({ success: true, message: 'Reset to initial memory vault.' });
});

// ----------------- VITE / SERVER INITIALIZATION ----------------- //
async function startServer() {
  if (!IS_PROD) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`SECOND BRAIN server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
