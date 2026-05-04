/**
 * Google Apps Script: создание таблицы для шаблонов рассылки.
 * Разверните как веб-приложение (Execute as: Me, Who has access: Anyone).
 *
 * POST body (JSON):
 *   secret: string — совпадает с APPS_SCRIPT_SECRET в .env
 *   userId: string — id пользователя
 *   name: string — название таблицы
 *   headers: string[] — массив заголовков первой строки (все колонки бэкапа)
 *
 * Ответ: { success: true, editUrl, spreadsheetId, csvUrl } или { success: false, message }
 */

function doPost(e) {
  const result = handleRequest(e);
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleRequest(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return { success: false, message: 'No body' };
    }
    const body = JSON.parse(e.postData.contents);
    const secret = body.secret;
    const expectedSecret = PropertiesService.getScriptProperties().getProperty('SECRET');
    if (!expectedSecret || secret !== expectedSecret) {
      return { success: false, message: 'Invalid secret' };
    }

    const name = body.name || 'Templates';
    const headers = Array.isArray(body.headers) && body.headers.length > 0
      ? body.headers
      : [
          'enabled', 'order', 'title', 'text', 'media_url',
          'send_media_as_file', 'wa_speed_factor', 'tg_speed_factor',
          'wa_default_send_time', 'tg_default_send_time'
        ];

    const ss = SpreadsheetApp.create(name);
    const sheet = ss.getSheets()[0];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);

    const file = DriveApp.getFileById(ss.getId());
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.EDIT);

    const spreadsheetId = ss.getId();
    const editUrl = ss.getUrl();
    const csvUrl = 'https://docs.google.com/spreadsheets/d/' + spreadsheetId + '/export?format=csv&gid=0';

    return {
      success: true,
      editUrl: editUrl,
      spreadsheetId: spreadsheetId,
      csvUrl: csvUrl
    };
  } catch (err) {
    return {
      success: false,
      message: (err && err.message) ? err.message : String(err)
    };
  }
}
