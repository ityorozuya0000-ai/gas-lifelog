/**
 * LifeLog App - Backend (Google Apps Script)
 * AI解析、ライフリズム分析、およびデータ永続化
 */

const CONFIG = {
  SHEETS: { LOGS: 'logs', CATS: 'categories' },
  HEADERS: {
    LOGS: ['id', 'date', 'start', 'end', 'cat', 'label', 'updated_at'],
    CATS: ['id', 'label', 'color', 'updated_at']
  },
  PROP_KEY: 'GEMINI_API_KEY'
};

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('LifeLog')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function triggerAuth() {
  const response = UrlFetchApp.fetch("https://www.google.com", {muteHttpExceptions: true});
  console.log("Authorization OK. Status: " + response.getResponseCode());
}

// --- フロントエンド向け 公開API ---

function apiGetAllData() { return runSafe(() => new Database().getAllData()); }
function apiUpsertLog(data) { return runSafe(() => new Database().upsert(CONFIG.SHEETS.LOGS, data)); }
function apiDeleteLog(id) { return runSafe(() => new Database().remove(CONFIG.SHEETS.LOGS, id)); }
function apiUpsertCategory(data) { return runSafe(() => new Database().upsert(CONFIG.SHEETS.CATS, data)); }
function apiDeleteCategory(id) { return runSafe(() => new Database().remove(CONFIG.SHEETS.CATS, id)); }
function apiSaveSettings(key) { return runSafe(() => {
  PropertiesService.getScriptProperties().setProperty(CONFIG.PROP_KEY, key);
  return true;
}); }
function apiGetSavedApiKey() { return PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEY) || ""; }

/**
 * AI活動抽出API
 */
function apiProxyGemini(params) {
  return runSafe(() => {
    const key = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEY);
    if (!key) throw new Error("APIキーが未登録です。");

    const systemPrompt = `ライフログ抽出AI。ユーザーの入力から活動記録を抽出し、JSON配列形式 [] で返せ。
      抽出キー: label, start(HH:MM), end(HH:MM), cat(カテゴリID), date(YYYY-MM-DD)。
      【重要】
      1. 日付指定がなければ基準日(${params.dateStr})を使用。
      2. 深夜(0:00-3:55)の開始時間は、指定日の終盤（夜の続き）として扱うため、入力通りの日付を返せ。
      3. カテゴリ選択肢: [${params.categoriesContext}]
      JSONのみ出力せよ。`;
    
    return callGemini(key, systemPrompt, params.userQuery, true);
  });
}

/**
 * ✨ AIライフリズム分析API
 */
function apiGenerateInsight(params) {
  return runSafe(() => {
    const key = PropertiesService.getScriptProperties().getProperty(CONFIG.PROP_KEY);
    if (!key) throw new Error("APIキーが未登録です。");

    const systemPrompt = `ライフログ分析アドバイザー。提供された${params.periodName}の活動データを読み解き、
      ユーザーに寄り添った優しく前向きなフィードバックとアドバイスを300文字程度で生成してください。
      構成案:
      - 全体的な生活リズムの評価（睡眠や仕事のバランス）
      - 特筆すべき良い点への称賛
      - 生活の質を上げるための小さな提案
      口調は親しみやすく、Markdown形式で回答（ただし見出しは不使用）してください。`;
    
    const logsText = params.logs.map(l => `- ${l.date} ${l.start}-${l.end}: ${l.label}`).join('\n');
    const userPrompt = `以下のログを分析してアドバイスをください：\n\n${logsText}`;

    return callGemini(key, systemPrompt, userPrompt, false);
  });
}

/**
 * Gemini API 共通呼び出し関数
 */
function callGemini(key, systemPrompt, userPrompt, isJson) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`;
  const payload = {
    contents: [{ parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] }
  };
  if (isJson) payload.generationConfig = { responseMimeType: "application/json" };

  const response = UrlFetchApp.fetch(url, {
    method: "post", contentType: "application/json",
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) throw new Error("Gemini APIエラー: " + response.getContentText());
  
  let text = JSON.parse(response.getContentText()).candidates[0].content.parts[0].text;
  if (isJson) {
    // 不要なMarkdown装飾を削除してJSONとしてパース
    text = text.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(text);
  }
  return text;
}

function runSafe(fn) {
  try { return { success: true, data: fn() }; } 
  catch (e) { return { success: false, error: e.message || e.toString() }; }
}

class Database {
  constructor() { this.ss = SpreadsheetApp.getActiveSpreadsheet(); this.initSheets(); }
  initSheets() {
    Object.keys(CONFIG.SHEETS).forEach(key => {
      if (!this.ss.getSheetByName(CONFIG.SHEETS[key])) {
        const sheet = this.ss.insertSheet(CONFIG.SHEETS[key]);
        sheet.getRange(1, 1, 1, CONFIG.HEADERS[key].length).setValues([CONFIG.HEADERS[key]]).setFontWeight('bold');
        sheet.setFrozenRows(1);
      }
    });
  }
  getAllData() { 
    return { 
      entries: this.read(CONFIG.SHEETS.LOGS), 
      categories: this.read(CONFIG.SHEETS.CATS),
      apiKey: apiGetSavedApiKey()
    }; 
  }
  read(name) {
    const sheet = this.ss.getSheetByName(name);
    if (!sheet) return [];
    const vals = sheet.getDataRange().getValues();
    if (vals.length < 2) return [];
    const headers = vals.shift();
    const tz = Session.getScriptTimeZone();
    return vals.map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        let v = row[i];
        if (v instanceof Date) {
          if (h === 'date') v = Utilities.formatDate(v, tz, "yyyy-MM-dd");
          else if (h === 'start' || h === 'end') v = Utilities.formatDate(v, tz, "HH:mm");
          else v = Utilities.formatDate(v, tz, "yyyy-MM-dd HH:mm:ss");
        }
        else if (typeof v === 'number' && (h === 'start' || h === 'end')) v = Utilities.formatDate(new Date(0,0,0,0,0,Math.round(v*86400)), tz, "HH:mm");
        obj[h] = (h === 'id') ? String(v) : v;
      });
      return obj.id ? obj : null;
    }).filter(x => x);
  }
  upsert(name, data) {
    const sheet = this.ss.getSheetByName(name);
    const vals = sheet.getDataRange().getValues();
    const headers = vals[0];
    const targetId = String(data.id);
    let rowIdx = -1;
    for (let i = 1; i < vals.length; i++) { if (String(vals[i][0]) === targetId) { rowIdx = i + 1; break; } }
    const rowData = headers.map(h => h === 'updated_at' ? new Date() : (h === 'id' ? targetId : (data[h] || "")));
    if (rowIdx > 0) sheet.getRange(rowIdx, 1, 1, rowData.length).setValues([rowData]);
    else sheet.appendRow(rowData);
    return true;
  }
  remove(name, id) {
    const sheet = this.ss.getSheetByName(name);
    const vals = sheet.getDataRange().getValues();
    for (let i = vals.length - 1; i >= 1; i--) { if (String(vals[i][0]) === String(id)) sheet.deleteRow(i + 1); }
    return true;
  }
}