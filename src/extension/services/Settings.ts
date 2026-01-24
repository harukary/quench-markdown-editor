import * as vscode from "vscode";
import { QuenchSettings } from "../../shared/protocol";

export function getQuenchSettings(): QuenchSettings {
  const quench = vscode.workspace.getConfiguration("quench");
  const css = quench.get<unknown>("css");
  // VSCodeは設定をフラットキーでも取得できるが、型を明確にするため個別に読む。
  const cssFiles = quench.get<string[]>("css.files", []);
  const cssReloadOnSave = quench.get<boolean>("css.reloadOnSave", true);
  const syntaxVisibility = quench.get<QuenchSettings["syntaxVisibility"]>("preview.syntaxVisibility", "smart");
  const previewOnHover = quench.get<boolean>("links.previewOnHover", true);
  const slugStyle = quench.get<QuenchSettings["slugStyle"]>("links.slugStyle", "github");

  const attachmentsLocation = quench.get<QuenchSettings["attachments"]["location"]>(
    "attachments.location",
    "subfolder"
  );
  const attachmentsFolderPath = quench.get<string>("attachments.folderPath", "attachments");
  const attachmentsSubfolderName = quench.get<string>("attachments.subfolderName", "attachments");
  const attachmentsNaming = quench.get<QuenchSettings["attachments"]["naming"]>("attachments.naming", "timestamp");

  const allowExternalImages = quench.get<boolean>("security.allowExternalImages", false);
  const allowHtmlEmbeds = quench.get<boolean>("security.allowHtmlEmbeds", false);
  const allowIframes = quench.get<boolean>("security.allowIframes", false);

  // ここでのバリデーションは「勝手なフォールバック」を避けるため最小限に留める。
  // 不正値はそのまま返すのではなく、既定値にせずエラー通知の対象にするのが理想だが、
  // VSCodeの設定UIがenum/型を担保する前提でここでは追加の矯正をしない。
  void css;

  return {
    cssFiles,
    cssReloadOnSave,
    syntaxVisibility,
    previewOnHover,
    slugStyle,
    attachments: {
      location: attachmentsLocation,
      folderPath: attachmentsFolderPath,
      subfolderName: attachmentsSubfolderName,
      naming: attachmentsNaming
    },
    security: {
      allowExternalImages,
      allowHtmlEmbeds,
      allowIframes
    }
  };
}

