// MOHD.HMS ENTERPRISE — CMS page renderer (§CMS).
// Renders a page-builder JSON document into React elements. Shared by the
// public website, the preview API, and the editor canvas (read-only view).
//
// Page content schema:
//   { blocks: [ { id, type, props, children?: Block[] } ] }
// Block types: section, container, columns, column, heading, text, image,
// button, divider, spacer, html.

"use client";

import React from "react";
import Image from "next/image";

export type Block = { id: string; type: string; props?: Record<string, unknown>; children?: Block[] };

type RendererProps = { blocks: Block[]; className?: string };

// Inline style helper — keeps the public site dependency-free and predictable.
function style(props: Record<string, unknown>): React.CSSProperties {
  const s: React.CSSProperties = {};
  const num = (k: string) => {
    const v = props[k];
    return typeof v === "number" ? v : undefined;
  };
  if (props.backgroundColor) s.backgroundColor = String(props.backgroundColor);
  if (props.color) s.color = String(props.color);
  if (props.fontSize) s.fontSize = String(props.fontSize);
  if (props.textAlign) s.textAlign = String(props.textAlign) as React.CSSProperties["textAlign"];
  if (props.padding) s.padding = String(props.padding);
  if (props.margin) s.margin = String(props.margin);
  if (props.width) s.width = String(props.width);
  if (props.height) s.height = String(props.height);
  if (props.borderRadius) s.borderRadius = String(props.borderRadius);
  const minH = num("minHeight"); if (minH !== undefined) s.minHeight = minH;
  const maxW = num("maxWidth"); if (maxW !== undefined) s.maxWidth = maxW;
  return s;
}

function cn(...classes: (string | undefined | null | boolean)[]): string {
  return classes.filter(Boolean).join(" ");
}

// ─── Blocks ────────────────────────────────────────────────────────────────

function Section({ block }: { block: Block }) {
  const p = block.props ?? {};
  return (
    <section
      className={cn("cms-block cms-section", p.className as string)}
      style={style(p as Record<string, unknown>)}
      data-block-id={block.id}
      data-block-type="section"
    >
      {block.children && block.children.map((c) => renderBlock(c))}
    </section>
  );
}

function Container({ block }: { block: Block }) {
  const p = block.props ?? {};
  return (
    <div
      className={cn("cms-block cms-container", p.className as string)}
      style={style(p as Record<string, unknown>)}
      data-block-id={block.id}
      data-block-type="container"
    >
      {block.children && block.children.map((c) => renderBlock(c))}
    </div>
  );
}

function Columns({ block }: { block: Block }) {
  const p = block.props ?? {};
  const gap = String(p.gap ?? "1.5rem");
  return (
    <div
      className={cn("cms-block cms-columns", p.className as string)}
      style={{ display: "flex", flexWrap: "wrap", gap, ...style(p as Record<string, unknown>) }}
      data-block-id={block.id}
      data-block-type="columns"
    >
      {block.children && block.children.map((c) => renderBlock(c))}
    </div>
  );
}

function Column({ block }: { block: Block }) {
  const p = block.props ?? {};
  const width = String(p.width ?? "100%");
  return (
    <div
      className={cn("cms-block cms-column", p.className as string)}
      style={{ flex: `0 0 ${width}`, minWidth: 0, ...style(p as Record<string, unknown>) }}
      data-block-id={block.id}
      data-block-type="column"
    >
      {block.children && block.children.map((c) => renderBlock(c))}
    </div>
  );
}

function Heading({ block }: { block: Block }) {
  const p = block.props ?? {};
  const Tag = String(p.tag ?? "h2") as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  return (
    <Tag
      className={cn("cms-block cms-heading", p.className as string)}
      style={style(p as Record<string, unknown>)}
      data-block-id={block.id}
      data-block-type="heading"
      dangerouslySetInnerHTML={{ __html: String(p.text ?? "") }}
    />
  );
}

function Text({ block }: { block: Block }) {
  const p = block.props ?? {};
  const Tag = String(p.tag ?? "p") as "p" | "div" | "span";
  return (
    <Tag
      className={cn("cms-block cms-text", p.className as string)}
      style={style(p as Record<string, unknown>)}
      data-block-id={block.id}
      data-block-type="text"
      dangerouslySetInnerHTML={{ __html: String(p.text ?? "") }}
    />
  );
}

function ImageBlock({ block }: { block: Block }) {
  const p = block.props ?? {};
  const src = String(p.src ?? "");
  const alt = String(p.alt ?? "");
  const width = numProp(p.width);
  const height = numProp(p.height);
  if (!src) return <div className="cms-block cms-image-placeholder" data-block-id={block.id} data-block-type="image">&nbsp;</div>;
  return (
    <div className={cn("cms-block cms-image", p.className as string)} style={style(p as Record<string, unknown>)} data-block-id={block.id} data-block-type="image">
      <Image src={src} alt={alt} width={width} height={height} style={{ maxWidth: "100%", height: "auto", display: "block" }} />
    </div>
  );
}
function numProp(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function Button({ block }: { block: Block }) {
  const p = block.props ?? {};
  return (
    <button
      className={cn("cms-block cms-button btn", p.className as string)}
      style={style(p as Record<string, unknown>)}
      data-block-id={block.id}
      data-block-type="button"
      onClick={(e) => { e.preventDefault(); }}
    >
      {String(p.text ?? "Button")}
    </button>
  );
}

function Divider({ block }: { block: Block }) {
  const p = block.props ?? {};
  return (
    <hr
      className={cn("cms-block cms-divider", p.className as string)}
      style={style(p as Record<string, unknown>)}
      data-block-id={block.id}
      data-block-type="divider"
    />
  );
}

function Spacer({ block }: { block: Block }) {
  const p = block.props ?? {};
  return (
    <div
      className={cn("cms-block cms-spacer", p.className as string)}
      style={{ height: String(p.height ?? "1rem"), ...style(p as Record<string, unknown>) }}
      data-block-id={block.id}
      data-block-type="spacer"
    />
  );
}

function Html({ block }: { block: Block }) {
  const p = block.props ?? {};
  return (
    <div
      className={cn("cms-block cms-html", p.className as string)}
      style={style(p as Record<string, unknown>)}
      data-block-id={block.id}
      data-block-type="html"
      dangerouslySetInnerHTML={{ __html: String(p.html ?? "") }}
    />
  );
}

// ─── Registry ─────────────────────────────────────────────────────────────

const BLOCKS: Record<string, (props: { block: Block }) => React.ReactElement> = {
  section: Section,
  container: Container,
  columns: Columns,
  column: Column,
  heading: Heading,
  text: Text,
  image: ImageBlock,
  button: Button,
  divider: Divider,
  spacer: Spacer,
  html: Html,
};

function renderBlock(block: Block): React.ReactElement {
  const Comp = BLOCKS[block.type];
  if (!Comp) return <div className="cms-block cms-unknown" data-block-id={block.id} data-block-type={block.type}>[Unknown block: {String(block.type)}]</div>;
  return <Comp key={block.id} block={block} />;
}

// ─── Public renderer ─────────────────────────────────────────────────────

export default function RenderPage({ blocks, className }: RendererProps) {
  const bs = Array.isArray(blocks) ? blocks : [];
  return (
    <div className={cn("cms-page", className)} data-cms-page="true">
      {bs.map((b) => renderBlock(b))}
    </div>
  );
}
