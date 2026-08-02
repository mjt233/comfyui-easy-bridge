<template>
  <!-- 使用 v-html 渲染 markdown-it 输出的安全 HTML（html: false 已转义原始 HTML） -->
  <div class="markdown-view" v-html="renderedHtml"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import java from 'highlight.js/lib/languages/java';
import yaml from 'highlight.js/lib/languages/yaml';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import sql from 'highlight.js/lib/languages/sql';
import markdown from 'highlight.js/lib/languages/markdown';
import 'highlight.js/styles/atom-one-dark.css';

// 注册常用语言，供 markdown 代码块高亮使用
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('java', java);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('markdown', markdown);

/**
 * Markdown 渲染器实例（模块级单例）
 * - html: false：转义原始 HTML，避免 XSS
 * - linkify: true：自动识别裸链接
 * - breaks: true：单换行渲染为 <br>
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  /**
   * 代码块高亮回调：优先按语言高亮，未知语言自动检测，失败回退转义
   * @param str 代码文本
   * @param lang 语言标识（围栏代码块后标注的语言）
   * @returns 高亮后的 HTML 片段
   */
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return (
          `<pre class="markdown-code"><code class="hljs language-${md.utils.escapeHtml(lang)}">` +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          '</code></pre>'
        );
      } catch {
        // 高亮异常时回退到转义输出
      }
    }
    return (
      '<pre class="markdown-code"><code class="hljs">' +
      md.utils.escapeHtml(str) +
      '</code></pre>'
    );
  },
});

const props = defineProps<{
  /** Markdown 源文本 */
  source: string;
}>();

/** 渲染后的 HTML 字符串 */
const renderedHtml = computed(() => md.render(props.source ?? ''));
</script>

<style>
/* 全局样式（v-html 内容无法被 scoped 命中），以 .markdown-view 命名空间隔离 */
.markdown-view {
  /* Material Design body 排版基线 */
  font-family: 'Roboto', 'Segoe UI', 'Microsoft YaHei', sans-serif;
  font-size: 0.875rem;
  line-height: 1.6;
  letter-spacing: 0.00938em;
  color: rgba(0, 0, 0, 0.87);
  word-break: break-word;
}

.markdown-view > *:first-child {
  margin-top: 0;
}

.markdown-view > *:last-child {
  margin-bottom: 0;
}

/* 标题 */
.markdown-view h1,
.markdown-view h2,
.markdown-view h3,
.markdown-view h4,
.markdown-view h5,
.markdown-view h6 {
  color: rgba(0, 0, 0, 0.87);
  font-weight: 500;
  line-height: 1.3;
  margin: 1.2em 0 0.5em;
}

.markdown-view h1 {
  font-size: 1.75rem;
  letter-spacing: -0.0125em;
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
  padding-bottom: 0.3em;
}

.markdown-view h2 {
  font-size: 1.375rem;
  letter-spacing: 0;
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
  padding-bottom: 0.25em;
}

.markdown-view h3 {
  font-size: 1.125rem;
  letter-spacing: 0.0025em;
}

.markdown-view h4 {
  font-size: 1rem;
  letter-spacing: 0.00625em;
}

.markdown-view h5 {
  font-size: 0.875rem;
  letter-spacing: 0.01em;
}

.markdown-view h6 {
  font-size: 0.8125rem;
  letter-spacing: 0.01em;
  color: rgba(0, 0, 0, 0.6);
}

/* 段落与内联元素 */
.markdown-view p {
  margin: 0.6em 0;
}

.markdown-view a {
  color: #1565c0;
  text-decoration: none;
}

.markdown-view a:hover {
  text-decoration: underline;
}

.markdown-view strong {
  font-weight: 600;
}

.markdown-view em {
  font-style: italic;
}

.markdown-view del {
  color: rgba(0, 0, 0, 0.5);
}

.markdown-view code:not(.hljs) {
  font-family: 'Roboto Mono', Consolas, 'Courier New', monospace;
  font-size: 0.8125em;
  background: rgba(0, 0, 0, 0.06);
  border-radius: 4px;
  padding: 0.15em 0.35em;
}

/* 代码块（markdown-it highlight 输出 .markdown-code 包装） */
.markdown-view pre.markdown-code {
  background: #282c34;
  border-radius: 8px;
  padding: 14px 16px;
  margin: 0.8em 0;
  overflow-x: auto;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2), 0 1px 2px rgba(0, 0, 0, 0.12);
}

.markdown-view pre.markdown-code code {
  font-family: 'Roboto Mono', Consolas, 'Courier New', monospace;
  font-size: 0.8125rem;
  line-height: 1.5;
  background: transparent;
  padding: 0;
}

/* 引用块 */
.markdown-view blockquote {
  margin: 0.8em 0;
  padding: 0.4em 1em;
  border-left: 4px solid #1565c0;
  background: rgba(21, 101, 192, 0.06);
  border-radius: 0 6px 6px 0;
  color: rgba(0, 0, 0, 0.66);
}

.markdown-view blockquote > *:first-child {
  margin-top: 0;
}

.markdown-view blockquote > *:last-child {
  margin-bottom: 0;
}

/* 列表 */
.markdown-view ul,
.markdown-view ol {
  margin: 0.6em 0;
  padding-left: 1.6em;
}

.markdown-view li {
  margin: 0.25em 0;
}

.markdown-view li::marker {
  color: #1565c0;
}

.markdown-view input[type='checkbox'] {
  margin-right: 0.4em;
}

/* 分割线 */
.markdown-view hr {
  border: none;
  border-top: 1px solid rgba(0, 0, 0, 0.12);
  margin: 1.2em 0;
}

/* 表格 */
.markdown-view table {
  border-collapse: collapse;
  width: 100%;
  margin: 0.8em 0;
  font-size: 0.875rem;
}

.markdown-view th,
.markdown-view td {
  border: 1px solid rgba(0, 0, 0, 0.12);
  padding: 8px 12px;
  text-align: left;
}

.markdown-view th {
  background: rgba(0, 0, 0, 0.04);
  font-weight: 600;
}

.markdown-view tr:nth-child(even) td {
  background: rgba(0, 0, 0, 0.02);
}

/* 图片 */
.markdown-view img {
  max-width: 100%;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}
</style>
