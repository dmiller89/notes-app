import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { SYSTEM_PROMPT, buildUserPrompt } from "@/lib/prompts";
import { NextRequest, NextResponse } from "next/server";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!
);

export async function POST(req: NextRequest) {
  const { jot, userId } = await req.json();

  // Step 1: Generate embedding for the new jot
  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: jot,
  });
  const jotEmbedding = embeddingResponse.data[0].embedding;

  // Step 2: Find similar existing notes
  const { data: similarNotes } = await supabase.rpc("match_notes", {
    query_embedding: jotEmbedding,
    match_user_id: userId,
    match_threshold: 0.5,
    match_count: 5,
  });

  // Step 3: Fetch user's existing tags
  const { data: tags } = await supabase
    .from("tags")
    .select("name")
    .eq("user_id", userId);
  const existingTags = (tags || []).map((t) => t.name);

  // Step 4: Ask Claude to classify and process
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserPrompt(jot, similarNotes || [], existingTags),
      },
    ],
  });

  // Step 5: Parse Claude's response
  const responseText =
    message.content[0].type === "text" ? message.content[0].text : "";
  const decision = JSON.parse(responseText);

  // Step 6: Save to database
  let noteId: string;

  if (decision.action === "merge" && decision.merge_target_id) {
    // Update existing note
    const { data } = await supabase
      .from("notes")
      .update({
        title: decision.title,
        content: decision.content,
        updated_at: new Date().toISOString(),
      })
      .eq("id", decision.merge_target_id)
      .select("id")
      .single();
    noteId = data!.id;
  } else {
    // Create new note
    const { data } = await supabase
      .from("notes")
      .insert({
        user_id: userId,
        title: decision.title,
        content: decision.content,
      })
      .select("id")
      .single();
    noteId = data!.id;
  }

  // Step 7: Re-generate embedding for the updated/new note
  const noteEmbeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: decision.content,
  });
  await supabase
    .from("notes")
    .update({ embedding: noteEmbeddingResponse.data[0].embedding })
    .eq("id", noteId);

  // Step 8: Upsert tags and link to note
  for (const tagName of decision.tags) {
    // Insert tag if it doesn't exist, get ID either way
    const { data: tag } = await supabase
      .from("tags")
      .upsert(
        { user_id: userId, name: tagName },
        { onConflict: "user_id,name" }
      )
      .select("id")
      .single();

    if (tag) {
      await supabase
        .from("note_tags")
        .upsert({ note_id: noteId, tag_id: tag.id });
    }
  }

  // Step 9: Save the jot with its result
  await supabase.from("jots").insert({
    user_id: userId,
    content: jot,
    processed: true,
    result_note_id: noteId,
    result_action: decision.action,
  });

  return NextResponse.json({
    action: decision.action,
    noteId,
    title: decision.title,
    tags: decision.tags,
  });
}