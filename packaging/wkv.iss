; 世界观查询器 —— Inno Setup 安装脚本（P8）
;
; 布局与 packaging/build.py 的产物一一对应（out/WorldKeeper/ 下），
; 改了 build.py 的输出结构，这里必须跟着改 —— 两边是同一条流水线的两半。
;
; 编译：ISCC packaging/wkv.iss   （或跑 packaging/build.py，它会自动调）
;
; ── 这份脚本守着的三条铁律 ──────────────────────────────────────────
; 1. 程序目录（{app}，只读）≠ 数据目录（用户可写）—— 用户在向导里选数据目录，
;    我们把它写进 {app}\config\config.yaml 的 storage.data_dir（安装期程序目录还
;    可写，这是唯一能写它的时机）。卸载**绝不**删数据目录。
; 2. 数据目录只能由「种子文件或环境变量」定 —— 所以必须在安装期写进种子。
;    写进用户配置没用（那份数据目录位置只认种子，防自搬）。
; 3. 卸载必须先停进程 —— 托盘和后端占着 exe，不停就删不掉。

#define MyAppName "世界观查询器"
#define MyAppNameEn "WorldKeeper"
#define MyAppVersion "0.2.0"
#define MyAppPublisher "世界观查询器"
#define MyAppExeName "WorldKeeper.exe"

[Setup]
; AppId 换了 Windows 就当成另一个程序 —— 升级装不上、卸载卸不干净。永不改。
AppId={{E4C344CF-1261-48B1-99B1-25CED398643C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppNameEn}
DefaultGroupName={#MyAppName}
UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\runtime\{#MyAppExeName}

; ── 许可协议页（用户必须显式点「我接受」才能继续）──
; 为什么必须有这一页：本程序是**专有 / 保留所有权利**（见根目录 LICENSE）。
; 协议里有限制再发行、限制销售、要求自行备份数据这些条款 —— 用户**没在安装时
; 被明确告知并同意**，那些条款在真出事时就很难站得住。
; 一份没人看过的协议等于没有协议，所以不能只把文件塞在安装目录里。
;
; 文件由 build.py 的 copy_docs() 生成：**纯文本**（Markdown 已剥掉 ——
; Inno 的许可页不认 Markdown，`#`/`**`/`---` 会原样显示成符号，看着像草稿）
; 且带 UTF-8 BOM（不然中文会被当 ANSI 显示成乱码）。
; 路径相对本 .iss 文件所在目录（packaging/），必须与 build.py 的产物对上。
LicenseFile=out\WorldKeeper\LICENSE.txt

; ── 装进 Program Files 的前提 ──
; admin：写 Program Files 必须提权。
; x64compatible：让 {autopf} 解析成 C:\Program Files（64 位）而不是 (x86)。
;   缺了这行，64 位机器上会装进 Program Files (x86)，目录名就撒谎了。
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible

; ── 系统要求（N3：口径必须写死在安装器里，别让用户装完才发现）──
; MinVersion=10.0：Windows 10 / 11（两者内核都是 10.0.x）。
;   为什么是 10 而不是更低：**嵌入式 Python 3.13 本身就不支持 Win7**
;   （3.13 的底线是 8.1；要 Win7 得降到 3.8 再补一堆兼容改造，不值当）。
;   与其装完在用户机器上炸，不如在向导第一步就说清楚 —— Inno 会直接弹
;   「此程序需要 Windows 10 或更高版本」，比闪退友好得多。
; ArchitecturesAllowed：32 位 Windows 直接拒装。嵌入式包只带了 amd64 的
;   python313.dll，装上去也起不来。
MinVersion=10.0
ArchitecturesAllowed=x64compatible

; ── 卸载行为 ──
; CloseApplications：用 Windows 的 Restart Manager 检测「哪些文件正被占用」，
;   占用了就问用户要不要关掉 —— 比我们 taskkill 更准也更礼貌。
; RestartApplications=no：别在重启后自动恢复安装，让用户自己来。
CloseApplications=yes
RestartApplications=no

; AppMutex：托盘在跑时（互斥量存在），卸载前弹「请先退出程序」。
;   比起卸载时硬杀进程，先问一句更符合「别动用户正在用的东西」。
AppMutex=Global\WorldKeeperTrayMutex

; 版本信息（右键属性里显示的）
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} 安装程序
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}

; 产物
OutputDir=out
OutputBaseFilename={#MyAppNameEn}-Setup-{#MyAppVersion}
; lzma2 固实压缩：嵌入包里有大量相似字节（dll/pyd），压得动，能省下不少
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes

; ── 多语言 ──
; 中文语言包**随仓库走**（assets/ChineseSimplified.isl）。
; 为什么不引用 compiler:Languages\ChineseSimplified.isl：本机实测，官方安装包
; 装完的 Languages\ 目录里**没有**简中（简中在 issrc 仓库的官方目录里，
; 但不随安装包分发）—— 引用它换台机器就编译不过。随仓库走才可复现。
[Languages]
Name: "chinesesimplified"; MessagesFile: "assets\ChineseSimplified.isl"

[Tasks]
; 局域网放行：**默认不勾**。勾了才加防火墙规则 —— 端口是用户自己开的，
; 不是我们替他开的。反悔了在系统防火墙里删掉这条规则即可。
Name: "lanaccess"; Description: "允许手机在同一 WiFi 下访问（添加防火墙规则）"; \
    Flags: unchecked
; 桌面快捷方式：默认勾。开始菜单那条是必然有的（[Icons] 不带 Tasks 就是）。
Name: "desktopicon"; Description: "创建桌面快捷方式(&D)"; \
    Flags: checkedonce

; ── 为什么没有「开机自启」任务 ──
; 第一版写在这里（[Tasks] + [Registry] HKCU Run），编译时 Inno 给了个警告：
;   PrivilegesRequired=admin 但脚本用了 per-user 区域（HKCU）
; 这个警告抓到的是**真 bug**：安装器提权运行时，HKCU 解析成**管理员账户**的
; 注册表 —— 用户装完，开机自启写进了管理员的 Run 键，他自己开机**不会自启**。
;
; 正解不是关警告，是把它挪出安装器：「开机自启」是用户随时开关的偏好，
; 归属是**程序设置**（程序以普通用户跑，写自己的 HKCU 天经地义）。
; 安装器只管装程序。

[Files]
; ── runtime/：嵌入式 Python（exe 与 DLL 必须同目录，不能拆）──
Source: "out\WorldKeeper\runtime\*"; DestDir: "{app}\runtime"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

; ── app/：后端代码 ──
Source: "out\WorldKeeper\app\*"; DestDir: "{app}\app"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

; ── web/dist/：前端产物 ──
Source: "out\WorldKeeper\web\*"; DestDir: "{app}\web"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

; ── Lib/：第三方依赖（site-packages）──
Source: "out\WorldKeeper\Lib\*"; DestDir: "{app}\Lib"; \
    Flags: ignoreversion recursesubdirs createallsubdirs

; ── 根目录散件 ──
Source: "out\WorldKeeper\launcher.py"; DestDir: "{app}"; Flags: ignoreversion
Source: "out\WorldKeeper\config\*"; DestDir: "{app}\config"; \
    Flags: ignoreversion recursesubdirs
Source: "out\WorldKeeper\THIRD-PARTY-NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "out\WorldKeeper\许可与致谢.txt"; DestDir: "{app}"; Flags: ignoreversion
; 本程序自身的许可协议（专有）。单独放一份在安装目录根下，理由见 build.py 的 copy_docs()。
Source: "out\WorldKeeper\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "assets\worldkeeper.ico"; DestDir: "{app}\runtime"; Flags: ignoreversion

; ── 排障脚本 ──
; 二进制图标之外，这次装的是一个 .bat。为什么必须有它：**托盘版没有控制台**，
; 后端起不来时用户什么都看不见 —— VM 实测第一轮就被这个坑卡住（双击图标无下文）。
; 文件名刻意用纯粹 ASCII，内容也是纯 ASCII 且 CRLF：带中文的 .bat 会被 cmd
; 的代码页折腾坏，那时候排障脚本本身就成了新的 bug。
Source: "assets\debug-start.bat"; DestDir: "{app}"; Flags: ignoreversion

; ── 计划文档不进包 ──
; PLAN.md / docs/ 是开发资料，用户不需要。故意的。

[Dirs]
; 数据目录：装完就建好骨架（程序第一次启动也会建，这里先建是为了让
; 「打开数据目录」在第一次启动前就能用）。放在 [Dirs] 而不是 [Run]：
; 声明式、卸载时 Inno 自己知道要清（空了才清）。
Name: "{code:GetDataDir}"; Permissions: users-modify

[Icons]
; 开始菜单（必有）
Name: "{group}\{#MyAppName}"; Filename: "{app}\runtime\{#MyAppExeName}"; \
    WorkingDir: "{app}"; IconFilename: "{app}\runtime\worldkeeper.ico"
; 排障入口：托盘版无控制台，起不来时用户什么都看不见 —— 这条快捷方式必须显眼
Name: "{group}\{#MyAppName} 启动（排障模式）"; Filename: "{app}\debug-start.bat"; \
    WorkingDir: "{app}"; IconFilename: "{app}\runtime\worldkeeper.ico"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
; 许可与致谢入口。
; 为什么需要这一条：程序里**故意没有**「关于」页（界面是干活的地方，不是读法律文书的地方），
; 于是 LICENSE 与三方声明一直没有用户可见的入口 —— 它们只是躺在安装目录里，
; 谁也找不到，等于没附。给一条开始菜单快捷方式，双击用系统默认程序打开。
Name: "{group}\许可与致谢"; Filename: "{app}\许可与致谢.txt"; \
    IconFilename: "{app}\runtime\worldkeeper.ico"
; 桌面（Tasks 里默认勾）
Name: "{commondesktop}\{#MyAppName}"; Filename: "{app}\runtime\{#MyAppExeName}"; \
    WorkingDir: "{app}"; IconFilename: "{app}\runtime\worldkeeper.ico"; \
    Tasks: desktopicon

; ── 为什么没有 [Registry] 段 ──
; 第一版在这里写过 HKCU Run（开机自启），编译时被 Inno 的警告抓到真 bug：
; 提权安装时 HKCU 是**管理员**的注册表，写进去的自启用户自己用不上。
; 详见上面 [Tasks] 段的说明。安装器不碰任何 per-user 区域。

[Run]
; 防火墙规则 —— 只在勾了 lanaccess 时加。目标必须是 pythonw.exe：
; 真正监听端口的是它（后端子进程），不是托盘。
Filename: "netsh.exe"; \
    Parameters: "advfirewall firewall add rule name=""WorldKeeper 局域网访问"" dir=in action=allow program=""{app}\runtime\pythonw.exe"" enable=yes profile=private"; \
    Flags: runhidden; Tasks: lanaccess

; 卸载时删掉防火墙规则（无论当初加没加 —— 删不存在的规则只是报个错，无害）
[UninstallRun]
Filename: "netsh.exe"; \
    Parameters: "advfirewall firewall delete rule name=""WorldKeeper 局域网访问"""; \
    Flags: runhidden; RunOnceId: "DelFirewall"

; 装完启动 —— 托盘会自己拉起后端、开浏览器
[Run]
Filename: "{app}\runtime\{#MyAppExeName}"; \
    Description: "{cm:LaunchProgram,{#MyAppName}}"; \
    Flags: nowait postinstall skipifsilent

; ── 卸载兜底 ──
; CloseApplications（Restart Manager）是正路，但有个口子它盖不住：
; 用户用「排障模式.bat」手工拉起的后端是 python.exe，不在托盘进程树里，
; Restart Manager 认不出它属于本程序。所以这里补一道 targeted taskkill ——
; /IM 精确到我们的 exe，/T 连子进程一起 —— **绝不**杀所有 pythonw.exe
;（那可能是别的程序在用的）。
[UninstallRun]
Filename: "taskkill.exe"; \
    Parameters: "/IM ""{#MyAppExeName}"" /T /F"; Flags: runhidden; \
    RunOnceId: "KillTray"

; ── 卸载清理：运行期产物 ──
; 卸载器只删「自己装过的文件」，而 Python 会在代码目录里生成 __pycache__
; 这类运行期产物 —— 不清就会留下一个「看着还在」的空壳目录（用户实测反馈）。
; 整树清 (app) 是安全的，前提是数据目录与程序目录物理分离；这一点由下面
; [Code] 里数据目录页的校验闸保证（不许把数据目录选进 (app)）。
[UninstallDelete]
Type: filesandordirs; Name: "{app}\app\__pycache__"
Type: filesandordirs; Name: "{app}\Lib\__pycache__"
Type: filesandordirs; Name: "{app}\__pycache__"
; 早期版本若因提权运行把 data/ 落在程序目录，这里一并清掉（正常安装不会有）
Type: filesandordirs; Name: "{app}\data"
Type: filesandordirs; Name: "{app}"

[Code]
var
  DataDirPage: TInputDirWizardPage;
  ChosenDataDir: string;

{ 数据目录默认值：用户文档下。注意 Pascal 的花括号注释不能嵌套 ——
  注释里提 Inno 常量必须写成 (userdocs) 这种圆括号，否则第一个右花括号
  就把注释关掉，后半句会被当成代码（第一轮编译就是死在这）。 }
function DefaultDataDir(Param: string): string;
begin
  Result := ExpandConstant('{userdocs}\WorldKeeper');
end;

{ [Dirs] 里 Name 用 (code:GetDataDir) 引用它 —— 先建好目录骨架 }
function GetDataDir(Param: string): string;
begin
  if ChosenDataDir = '' then
    Result := DefaultDataDir('')
  else
    Result := ChosenDataDir;
end;

procedure InitializeWizard;
begin
  DataDirPage := CreateInputDirPage(wpSelectDir,
    '选择数据目录',
    '你的书稿、人物、时间线都存放在这里',
    '程序装在程序目录（只读，不碰它）。你的**数据**放在下面的目录 ——' #13#10 +
    '卸载程序不会删除它。建议留在默认位置。', False, '');
  DataDirPage.Add('数据目录：');
  DataDirPage.Values[0] := DefaultDataDir('');
end;

{ 翻过数据目录页时记下选择，并做一次**真的**可写性探测 }
function NextButtonClick(CurPageID: Integer): Boolean;
var
  d: string;
  probe: string;
begin
  Result := True;
  if CurPageID = DataDirPage.ID then
  begin
    d := RemoveBackslashUnlessRoot(Trim(DataDirPage.Values[0]));
    if d = '' then
    begin
      MsgBox('数据目录不能为空。', mbCriticalError, MB_OK);
      Result := False;
      Exit;
    end;
    ChosenDataDir := d;
    { 数据目录不许落进程序目录 —— [UninstallDelete] 会整树清 (app)，
      数据若选在那里，卸载就等于「焚稿」。这条闸是那道递归删除的安全前提。 }
    if Pos(LowerCase(ExpandConstant('{app}')), LowerCase(d)) = 1 then
    begin
      MsgBox('数据目录不能选在程序安装目录里面。' + #13#10#13#10 +
             '卸载程序会清理程序目录，放在那里的书稿会被一并删掉。' + #13#10 +
             '请换一个位置（比如默认的文档目录）。', mbCriticalError, MB_OK);
      Result := False;
      Exit;
    end;
    { 真写一个探针文件 —— os.access 在 Windows 上不可靠，这条更稳 }
    probe := d + '\.write_probe';
    if not ForceDirectories(d) then
    begin
      MsgBox('建不了目录：' + d + #13#10#13#10 +
             '可能没权限，或路径里有限制字符。', mbCriticalError, MB_OK);
      Result := False;
      Exit;
    end;
    if not SaveStringToFile(probe, 'ok', False) then
    begin
      MsgBox('这个目录写不进去：' + d + #13#10#13#10 +
             '换一个位置（比如默认的文档目录），或者用管理员身份重跑安装。', mbCriticalError, MB_OK);
      Result := False;
      Exit;
    end;
    DeleteFile(probe);
  end;
end;

{ 把选好的数据目录写进**种子**配置。只在 ssPostInstall 时机写 ——
  那时 (app) 里的文件都已就位，且还带着安装权限（装完就没权限了）。 }
procedure WriteDataDirSeed;
var
  f: string;
  lines: TStringList;
  i: Integer;
  safe: string;
begin
  if ChosenDataDir = '' then
    Exit;                                    { 用户没改默认值 → 留 null 让程序自己推导 }
  f := ExpandConstant('{app}\config\config.yaml');
  if not FileExists(f) then
    Exit;
  lines := TStringList.Create;
  try
    lines.LoadFromFile(f);
    { YAML 单引号里反斜杠是字面量 —— 路径不用转义；
      但路径里若真有单引号，得写成两个（YAML 的转义规则） }
    safe := ChosenDataDir;
    StringChangeEx(safe, '''', '''''', True);
    for i := 0 to lines.Count - 1 do
      if Pos('data_dir:', lines[i]) > 0 then
        lines[i] := '  data_dir: ''' + safe + '''    # 安装向导选的（改数据目录请重跑安装程序）';
    lines.SaveToFile(f);
  finally
    lines.Free;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteDataDirSeed;
end;
