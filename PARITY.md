# Cotton Music 网页版验收清单

当前对照为 Cotton Music 5.4.1 的公开功能，以官网、开发者功能说明和 App Store 版本记录为依据。阶段交付物是纯 Web 客户端及其本机服务端。CarPlay、原生系统资料库访问及系统级调用保留在后续平台验收范围。新版原版发布后，另记新增功能，不覆盖本清单的版本基线。

每项通过条件包含用户可见操作及其结果。网盘与服务器项目需要分别通过模拟测试和真实服务验收。物理投屏需要接收设备验收。

5.4.1 基线来自 Apple 版本记录。GitHub 与官网镜像没有该版本的公开桌面发行包，邻近的官方 5.4.2 Windows、Android 包已核对官方校验值。其资源标签与直接运行结果须分别记录，不能视为 5.4.1 的实机验收，也不能仅凭共享资源存在就断言某平台已启用功能。

| 功能 | 当前验证 | 待验收或补齐 |
| --- | --- | --- |
| 本地音频、文件夹和标签解析 | Chrome、WebKit 和 Firefox 已验证 WAV、AAC、持久曲库、同名歌词、WavPack 自动兼容播放及 APE、DSF、DFF 的标签和 FLAC 兼容播放。真实 24 位 96 kHz PCM 已逐样本比对。MP3 兼容播放实测保留 48 kHz 单声道，96 kHz 多声道转换为 MP3 支持的 48 kHz 立体声。经模拟授权的百度接口验证 DSF/DFF 原始字节及 Range | 其他高采样率和声道组合的设备兼容性，浏览器和设备的实际输出采样率 |
| 播放队列、拖动进度、循环、随机、续播 | 已验证随机按轮遍历、跨轮回退、播放下一首优先、单曲循环自动续播。含重复曲目的队列按原位置恢复，刷新后可沿之前的随机播放记录前后切换 | 原版随机算法和跨会话行为待对照 |
| 大型直连列表按需排队 | Chrome、Firefox 和 WebKit 用真实 Navidrome 验证关闭后从服务器歌单点歌只加入选中的重复条目，整组播放仍加入完整歌单。模拟目录验证直连专辑、艺人和普通文件夹。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v3.4.0) | 网页默认整组入队，原版阈值及跨分页行为待实机对照 |
| 记住单个歌单的上次播放曲目 | 音频设置可开启。整个歌单再次播放时从上一次的条目起播。已验证本地歌单的重复条目、排序、筛选和刷新，以及真实 Navidrome 的服务器歌单和本地镜像。服务端重新排序导致重复条目无法确认时，从第一首播放。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v2.6.3) | 默认关闭，从上次曲目开头播放。其他服务器的实际重复条目标识及原版歌单播完后的记忆行为待对照 |
| 播放页显示音频格式和码率 | Chrome、Firefox 和 WebKit 验证实际 FLAC、AAC 和由 FFmpeg 转换的兼容音频，界面读数与实际文件解析一致。真实认证 HTTPS WebDAV 验证按需分段读取 24 位 96 kHz FLAC。无法从文件读取的远端码率保持空缺，串流请求上限单独显示。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v5.1.1) | 其他编解码组合、媒体服务的实时转码码率和投屏接收器输出待验收 |
| 队列自动定位当前曲目 | 打开队列时滚到实际播放的队列项，正确区分重复曲目。用户浏览其他位置时保留其滚动和焦点。桌面 Chrome、Firefox、WebKit 及移动 Chrome、Firefox 验证了队列定位、键盘使用和封面手势。[原版队列定位](https://github.com/pure-music/PureMusic/issues/30#issuecomment-3117218024) | 原版自动跟随暂停条件待核对 |
| 下一首云端歌曲预加载 | 低优先级预读一首支持字节范围的原始音频。8 MiB 以内可直接复用完整内存副本。更大曲目符合强 ETag 校验且浏览器有 Service Worker 时，预读开头 256 KiB，播放时确认文件未变后接上剩余字节。Chrome、Firefox 和 WebKit 用真实 HTTPS WsgiDAV 验证小文件复用、大文件播放和跳转，以及文件变更后改用原始串流。[原版下一首预加载](https://github.com/pure-music/PureMusic/issues/189) | 个人网盘真实账号及原版缓冲策略待验收 |
| 曲库、搜索、专辑、艺人、歌单、收藏、播放历史、常听 | 已实现批量、Shift 范围选择、详情页长按多选、定位当前曲目和可选的播放详情自动打开。桌面和移动浏览器已验证长按选中、拖动取消和键盘多选。[原版长按多选](https://github.com/pure-music/PureMusic/issues/135) | 其他原版快捷操作仍需比对 |
| 多行显示长曲名 | 「设置 → 外观」可开启歌曲列表和队列的长曲名换行。Chrome、Firefox 和 WebKit 验证窄屏、键盘播放、刷新和备份恢复。移动 Chrome 和 Firefox 验证触控播放。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v3.6.7) | 网页默认关闭，原版默认及各界面的行数待实机核对 |
| 首页播放统计 | 显示今日与近 7 个本地日历日的播放次数，以及曾播放的不同曲目数。Chrome、Firefox 和 WebKit 验证空历史零值、日期边界、夏令时、重复播放与未来记录。[原版 5.4.0 发布记录](https://github.com/pure-music/PureMusic/releases/tag/v5.4.0) | 原版统计指标与计数口径未在发布说明列出，待实机比对 |
| 歌单内搜索、定位与回顶 | 本地及服务器歌单支持按歌曲、艺人、专辑筛选，从搜索结果播放完整队列。可在歌单内定位当前歌曲，双击标题回顶。[原版歌单搜索](https://github.com/pure-music/PureMusic/issues/154) · [歌单定位与回顶](https://github.com/pure-music/PureMusic/issues/137) | 原版触屏平台的回顶触发区域待比对 |
| 歌单批量调整顺序 | 在本地歌单的默认视图中多选并批量上移或下移。Chrome、Firefox 和 WebKit 已验证批量相对顺序、键盘焦点、刷新保留和当前播放队列。[原版多选调整](https://github.com/pure-music/PureMusic/issues/138) |
| 添加到多个歌单 | 在添加窗口切换多选、勾选目标歌单并确认。Chrome、Firefox 和 WebKit 已验证单曲及多曲、取消、多选数量及快捷单选。[原版多目标歌单](https://github.com/pure-music/PureMusic/issues/89) · [确认与多选优化](https://github.com/pure-music/PureMusic/issues/105) |
| 添加窗口优先显示最新歌单 | 按已知创建时间倒序排列，不跟随侧栏的手动或名称顺序。Chrome、Firefox 和 WebKit 验证新建、M3U 导入、单选、多选及刷新；旧歌单缺少日期时保留相对顺序。[原版维护者说明](https://github.com/pure-music/PureMusic/issues/105) |
| 全局文件夹搜索 | Chrome、Firefox、WebKit 验证了本地导入目录、已索引云端目录、扫描删除过期目录和重新连接后打开嵌套媒体目录。搜索期间从本机索引查找 | 个人网盘实测及原版索引范围对照，旧索引仅存内部编号的目录需重新扫描。[原版需求记录](https://github.com/pure-music/PureMusic/issues/132) |
| 全局搜索风格分组 | 搜索的风格分组排在文件夹之后，可打开匹配风格浏览歌曲。Chrome、Firefox 和 WebKit 验证了分类规则、Unicode 匹配和隐藏来源过滤。[原版搜索顺序](https://github.com/pure-music/PureMusic/issues/141) |
| 文件夹回到顶部 | 桌面浏览器验证真实本地目录回顶，移动 Chrome 和 Firefox 验证触控。模拟百度目录回顶保留播放和目录，无额外列表请求。[原版文件夹回顶](https://github.com/pure-music/PureMusic/issues/174) | 真实个人网盘验收 |
| 曲库和歌单回到顶部 | 网页工具栏支持回到歌曲、专辑、艺人、风格和歌单页面顶部。桌面键盘和移动触控已验证，歌单选择与筛选状态保留。[原版底栏回顶](https://github.com/pure-music/PureMusic/issues/140) |
| 首页推荐 | Chrome、Firefox、WebKit 已验证从已收录曲库推荐专辑和单曲。直接连接真实 Navidrome 0.64.2 后，无需先扫描便可查看最新专辑推荐和封面、打开专辑并播放。[原版直接连接推荐封面版本记录](https://apps.apple.com/jp/app/%E6%A3%89%E8%8A%B1%E9%9F%B3%E4%B9%90/id6752617064) · [OpenSubsonic 专辑接口](https://opensubsonic.github.io/docs/endpoints/getalbumlist2/) | 原版推荐排序细节及其他来源的直接连接推荐待对照 |
| 随机播放一张专辑 | 专辑总览随机选择整张专辑并随机选择起播曲目，自动启用随机模式。Chrome、Firefox 和 WebKit 验证队列只含该专辑、下一首及刷新恢复。[原版随机专辑](https://github.com/pure-music/PureMusic/issues/14) |
| 随机播放艺人 | 艺人详情可随机播放该艺人的跨专辑曲目。Chrome、Firefox 和 WebKit 验证随机起播、艺人范围、下一首和刷新恢复。[原版艺人分类随机播放](https://github.com/pure-music/PureMusic/issues/129) | 原版按钮位置和歌单分类行为待实机比对 |
| 列表排序 | 歌单、艺人、专辑、下载和云端目录支持独立排序。歌单顺序可手动调整和保存。专辑支持年份升降序，中英文界面均按拼音排列中文专辑名，年份相同也按此规则排序。三个浏览器已验证 | 其他列表的原版排序选项及未收录年份字段的服务行为。[原版年份排序](https://github.com/pure-music/PureMusic/issues/139) · [中文排序](https://github.com/pure-music/PureMusic/issues/143) |
| 歌单分类顺序 | 可在侧栏调整整个歌单的顺序。Chrome、Firefox、WebKit 验证顺序保留、播放继续和键盘操作。真实 HTTPS WsgiDAV 验证重排同步到第二个浏览器会话。[原版歌单分类顺序](https://github.com/pure-music/PureMusic/issues/136) |
| 按歌单名称、创建和修改时间排序 | 支持名称与创建时间升降序、最近修改优先，切回手动可恢复原顺序。Chrome、Firefox 和 WebKit 验证改名、增减成员更新时间，重排、设置和标签读取不更新时间；真实认证 HTTPS WebDAV 验证重复曲目、日期跨设备合并和旧标签页停止覆盖其他页面的新改动。旧歌单日期保持未知。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v3.3.1) | 个人网盘真实账号及原版旧数据排序待对照，旧版 WebDAV 客户端重新保存时可能省略日期 |
| 文件夹文件名排序 | 本地和云端文件夹可按文件名自然升降序排列，播放整个目录沿用当前顺序。Chrome、Firefox、WebKit 验证了真实本地文件名、内嵌曲名、播放队列和刷新保留，并覆盖模拟百度网盘目录。仅提供目录显示标题的媒体来源使用该标题。[原版带编号的文件名排序](https://github.com/pure-music/PureMusic/issues/124) |
| 文件夹播放位置恢复 | 「继续播放目录」恢复上次曲目和进度。Chrome、Firefox、WebKit 验证真实本地导入目录和两个独立的 HTTPS WsgiDAV 目录在刷新后分别续播，另验证主动从头与播放完毕。[原版位置恢复](https://github.com/pure-music/PureMusic/releases/tag/v4.0.0) | 网页采用显式续播入口，原版触发方式和个人网盘续播仍待验收 |
| 自动恢复播放位置开关 | 「设置 → 音频」可关闭自动恢复上次播放位置，重新打开时保留队列和当前曲目，从头暂停。默认开启，设置可随备份恢复。[原版播放设置](https://github.com/pure-music/PureMusic/issues/30#issuecomment-3117218024) | 原版默认选项待对照 |
| M3U 歌单导入 | Chrome、Firefox 和 WebKit 验证本地导入、真实 HTTPS WebDAV 文件 URL，以及真实 Navidrome 0.64.2 命令行生成的 M3U。接口虚拟文件名与导出磁盘路径不同时，可按歌单中的艺人和曲名唯一匹配。保留标题及收录顺序，报告跳过的重复或未匹配条目，刷新后可通过原来源播放。[原版导入歌单名](https://github.com/pure-music/PureMusic/issues/169) · [Navidrome 歌单导出](https://navidrome.org/docs/usage/admin/cli/pls/) | 原版对其他服务外部 URI、重复曲目和同名曲目的匹配策略待实测 |
| 云端内置标签批量读取 | 在 Chrome、Firefox 和 WebKit 通过真实 WebDAV 分段读取验证歌曲列表一键读取、显示进度、跳过已读取曲目、取消和刷新后保留结果 | 使用真实个人网盘验收 |
| 新增收录目录时增量扫描 | 在云端浏览页可一次勾选多个新目录。已收录目录保留，扫描仅访问选择的新目录。真实 HTTPS WsgiDAV 验证请求路径、刷新后的索引和全库刷新范围。[原版增量编辑来源版本记录](https://apps.apple.com/cn/app/%E6%A3%89%E8%8A%B1%E9%9F%B3%E4%B9%90/id6752617064) | 个人网盘和原版来源编辑界面的其余操作待验收 |
| 独立艺人照片 | 通过专辑核实 MusicBrainz 艺人身份后，从 Wikidata 和 Wikimedia Commons 查找照片并展示署名和许可证。已在浏览器走完 Daft Punk 照片的真实查询、显示和署名链接。三个浏览器另用固定数据验证艺人照片和专辑封面可分别显示 | 持续核对来源可用性、重名及未收录艺人的表现 |
| 艺人缺少照片时可用专辑封面 | Chrome、Firefox 和 WebKit 验证艺人列表与详情、艺人照片优先、手动查询和设置备份恢复。开启后选择属于该艺人的首张可用专辑封面，默认关闭。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v4.9.0) | 原版默认状态及专辑选择顺序待实机比对 |
| 播放时光机 | 按本地日期和时间显示，可打开可用曲目。实际听满半首或 3 分钟时记一次，以先达到的条件为准，跳过的片段不计。Chrome、Firefox 和 WebKit 验证了实际短曲、拖动、重播及备份恢复。JSON 备份可跨浏览器合并。[原版计数门槛](https://github.com/pure-music/PureMusic/issues/75) | 原版日期视图交互及备份互导格式待核对 |
| 歌单备份和云同步 | Chrome、Firefox 和 WebKit 在真实 HTTP 和 HTTPS WsgiDAV 验证上传、下载和合并、HTTP 412 冲突重试，以及已有曲目音频标签在另一浏览器恢复并即时更新播放栏。同步期间请求再次同步会排队。HTTPS 使用受信任的本地测试证书并保持 TLS 校验。[原版歌单备份与恢复版本记录](https://apps.apple.com/cn/app/%E6%A3%89%E8%8A%B1%E9%9F%B3%E4%B9%90/id6752617064) | 跨物理设备验证和原版备份格式互导比对 |
| 各云盘独立目录歌单备份 | WebDAV 已通过真实测试。百度网盘、Google Drive、Dropbox 和 OneDrive 个人账号支持确认上传、预览、验证曲目和合并恢复。浏览器和后端通过模拟网盘接口验证账号隔离、已有歌单保留和未知提交后的重试。Dropbox 另验证旧连接重新确认账号后单独申请备份权限，OneDrive 验证独立应用目录授权、创建时间及恢复期间文件变更。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v4.9.0) | 四种个人网盘的获批应用及真实账号写入待验收，OneDrive 工作或学校账号及其他云盘待接入 |
| 百度网盘 | 本机可用设备授权或授权码。实际百度签发设备码，初次轮询返回等待授权。浏览器验证了 HTTPS 回调域名引导、按配置原样显示完整回调地址，及错误诊断。模拟服务验证设备轮询、令牌兑换、目录、续期、加密会话恢复、Range、标签、歌词和离线播放。[百度回调排查](https://help.baidu.com/question?class=0&id=1002104&prod_id=257) | 百度账号同意授权后，实测令牌交换、目录及播放 |
| Google Drive、OneDrive、Dropbox、Box、pCloud、阿里云盘 | 已实现 OAuth、加密会话恢复、目录、Range 和同名歌词，通过模拟 HTTP | 每种服务用正式应用和真实测试账号连接并播放 |
| OneDrive 原始曲目 ID 兼容 | Chrome、Firefox 和 WebKit 用模拟 OneDrive 接口验证含 `!` 的曲目可离线保存，来源不可用并刷新后可播放浏览器副本。单元测试验证其可纳入歌单备份 | 实际 OneDrive 测试账号验收 |
| OneDrive Personal 扫描标签 | Chrome、Firefox 和 WebKit 用模拟 Graph 验证扫描直接采用歌曲、艺人、专辑、专辑艺人和时长，无需读取音频。缺少标签时使用原回退规则，自定义文件名规则可覆盖标签。[原版教程](https://music.caij.xyz/zh/faq/) · [Microsoft Graph 音频字段](https://learn.microsoft.com/en-us/graph/api/resources/audio?view=graph-rest-1.0) | 真实个人账号验收，微软仅对 Personal 提供音频字段 |
| Google Drive 备份增量授权 | 默认关闭。签发备份权限后检查账号与现有播放授权一致。模拟测试覆盖拒绝、返回其他账号、权限降级与重新授权，保留原有播放授权。[Google OAuth 文档](https://developers.google.com/identity/protocols/oauth2/web-server) | 真实应用增量授权及权限续期待验收 |
| 115 网盘 | 已实现官网授权、续期、目录和 Range，模拟测试通过 | 需获批应用与真实账号，关注官方维护进度 |
| 123 云盘 | 已接入官方第三方挂载 OAuth、列表、分段串流 | 获批企业应用及真实账号验收 |
| 移动云盘 | 尚未接入。[原版 4.8.0 发布记录](https://github.com/pure-music/PureMusic/releases/tag/v4.8.0) 明确列出该来源 | 核实官方开放接口、应用资质与授权方式，再实现播放及原版对应备份能力，不能凭营销网页推定私有协议 |
| 光鸭云盘 | 已实现官方 Web PKCE、列表、Range 和歌词，模拟测试通过 | 正式应用和实际账号验收 |
| 飞牛音乐 | 可通过用户配置的音桥 OpenSubsonic 服务接入。正式发布的音桥 1.0.7 使用模拟底层 API，在 Chrome、Firefox、WebKit 验证账号绑定、艺人及专辑浏览、封面、同步歌词、M4A 和 HTTP 206。接口测试另验证歌曲封面继承与回退 | 真实 fnOS 设备和账号联调、原版直连及 FN ID 自动选路待验收 |
| Songloft | Chrome、Firefox 和 WebKit 已在真实 Songloft 2.13.12 验证账号登录、已索引本地曲目、封面、同步歌词和 HTTP 206 原始音频。另用合成远程 M4A 验证字节范围及真实续期，测试主动缩短登录响应声明的有效期 | 长时间在线及其他远程音源组合 |
| Navidrome 歌单、本地镜像与播放记录 | 真实 Navidrome 0.64.2 在 Chrome、Firefox 和 WebKit 验证了服务器歌单顺序、重复曲目、保存镜像、刷新、重连、已下载歌曲的离线播放及独立删除。启用播放结束回传后，手动切歌不计数，同一歌曲两次自然结束均计数 | 原版同步触发时机及跨设备镜像行为待核对。[歌单顺序](https://github.com/pure-music/PureMusic/issues/190) · [播放结束回传](https://github.com/pure-music/PureMusic/issues/113) |
| Navidrome 批量同步服务器歌单 | Chrome、Firefox 和 WebKit 用真实 Navidrome 0.64.2 验证一次同步多个歌单到本地镜像，包括空歌单、重复曲目和服务端顺序。再次同步可更新已成功读取的歌单，个别请求失败时保留对应旧镜像。[原版同步模式](https://github.com/pure-music/PureMusic/issues/163) · [歌单顺序](https://github.com/pure-music/PureMusic/issues/190) | 网页版从服务器歌单目录手动触发同步，原版后台同步时机待核对 |
| 媒体服务器 Wi-Fi 和移动数据码率 | Navidrome、Subsonic 和 OpenSubsonic 可分别配置两种网络的码率。真实 Navidrome 在 Chrome、Firefox 和 WebKit 验证了 96 kbps MP3、同步歌词，以及离线下载仍与原 FLAC 字节一致。浏览器无法识别网络类型时，自动模式使用原始音源，也可手动选网络配置。[原版码率设置](https://github.com/pure-music/PureMusic/issues/61) · [OpenSubsonic 串流接口](https://opensubsonic.github.io/docs/endpoints/stream/) | 原版完整码率选项、其他服务器限速行为和手机网络识别待实测 |
| Emby 播放会话回传 | 真实 Emby 4.10.2.0 在 Chrome、Firefox 和 WebKit 验证了默认关闭、启用后仪表盘显示歌曲、暂停、跳转和恢复，结束后清除会话且播放次数增加一次 | 其他 Emby 版本和用户服务器验收。[Cotton Music Emby 回传](https://github.com/pure-music/PureMusic/issues/116) |
| ListenBrainz 收听回传 | 用户连接后，从下一首起按实际收听进度达到半首或 4 分钟时回传一次。Chrome、Firefox 和 WebKit 验证跳转不计、同一播放只报一次、断开后停止。真实接口验证无效令牌，提交内容用本地测试服务验证。[Cotton Music 回传记录](https://github.com/pure-music/PureMusic/issues/194) · [ListenBrainz 接口](https://listenbrainz.readthedocs.io/en/latest/users/api/core.html#post--1-submit-listens) | 令牌只保存在服务端内存，重启后需重新连接。真实账号接收回传待用户授权验收 |
| Emby 服务器歌单 | Chrome、Firefox 和 WebKit 用真实 Emby 4.10.2.0 验证枚举、顺序显示、添加、移除，以及同一浏览器会话重连和服务重启后打开已确认的空音乐歌单并加入第一首歌。接口测试覆盖重复条目、来源与歌单边界。[Emby 歌单接口](https://dev.emby.media/doc/restapi/Playlists.html) | Emby 4.10.2.0 的公开读取接口无法区分未标明媒体类型且从未识别的空音乐和视频歌单。换浏览器或过期会话需重新确认类型 |
| Jellyfin 服务器歌单 | Chrome、Firefox 和 WebKit 用真实 Jellyfin 12.4 验证顺序浏览、播放和本地镜像，以及新建私有空歌单、添加、精确移除或确认移除共用标识的全部重复条目。已验证只读与可编辑共享、指定用户的管理员 API 密钥、同一服务器不同地址下的写入串行，以及真实添加已提交但响应丢失时刷新结果且不重发。源文件字节未变化。[Jellyfin 歌单接口](https://github.com/jellyfin/jellyfin/blob/master/Jellyfin.Api/Controllers/PlaylistsController.cs) | 写入要求 10.9 及以后，旧版空歌单及原版其余管理操作待比对。原生移除接口没有条件版本，其他客户端仍可能在最终核对后改动条目 |
| Emby、Jellyfin 多碟专辑 | Chrome、Firefox 和 WebKit 用真实 Emby 4.10.2.0 和 Jellyfin 12.4 验证每碟放在独立子目录后，来源和曲库专辑页均按碟号和曲号分组。Emby 可进入单碟目录，也可返回整张专辑播放。Jellyfin 服务器歌单保留服务端顺序。[Cotton Music 多碟专辑记录](https://github.com/pure-music/PureMusic/issues/15) · [Emby 多碟标签](https://emby.media/learn/articles/libraries-collections/music/albums-credits/Library-Multi-Disc-Albums.html) · [Jellyfin 多碟布局](https://jellyfin.org/docs/general/server/media/music/#discs) | Emby 合并整张专辑需有可识别的碟目录名称和一致的专辑与碟号标签，其他布局按目录浏览 |
| WebDAV、Plex、Emby、Jellyfin、OpenSubsonic、Subsonic、Navidrome、Kodi | 模拟 HTTP 已验证登录、浏览和 Range。真实 Navidrome 0.64.2、Jellyfin 12.4 和 Emby 4.10.2.0 均已验证登录、浏览、FLAC、歌词和字节范围，Jellyfin 和 Emby 也已验证已有专辑封面。真实 Subsonic 6.1.6 与 Kodi 21.2 均在三个浏览器验证了授权、曲库浏览和原始字节分段读取，分别播放 M4A 和 FLAC。Kodi 也验证了缺少 MIME 响应头的 JPEG 封面 | Plex 真实账号与服务验收，其他服务的真实部署及未验收的封面行为 |
| 媒体来源重启恢复 | Chrome、Firefox 和 WebKit 用真实 HTTPS WebDAV、SMB2、Navidrome 0.64.2、Emby 4.10.2.0、Jellyfin 12.4、Kodi 21.2、Subsonic 6.1.6 和 Songloft 2.13.12 Lite 验证服务重启后直接使用原音频标识，无需先扫描。原始音频、封面、歌词及跨浏览器会话隔离通过；真实 Navidrome 与 Emby 回传、Jellyfin API 密钥歌单权限通过。其余协议以模拟接口验证无重新登录的恢复，包含 Songloft 令牌轮换。连接、索引和必要身份字段加密保存，过期、损坏、撤销和写入失败有独立测试 | 有效期沿用 7 天，首次升级的旧内存连接需重连。OpenSubsonic 独立连接类型、fnOS 与 Plex 的真实重启仍待验收；同一数据目录只支持一个服务进程 |
| 大曲库与来源索引容量 | Chrome、Firefox 和 WebKit 用真实认证 HTTPS WsgiDAV 的 20 个目录、20,000 个不同文件路径，验证后端建立独立音频索引；冷重启后先读取旧音频、封面、歌词地址，原始字节、206 和会话隔离通过。另验证单目录 1,000 行实际浏览和播放 | 已修复约 13.2 MB 状态超过 localStorage 配额导致刷新丢失的问题。三个浏览器验证整库扫描后存入 IndexedDB、较小设置状态、刷新后的搜索／收藏／队列和完整／删减备份恢复；另验证配额回滚、旧索引迁移、跨标签页冲突及标签更新。更多来源与更大规模待验收 |
| 完整备份恢复中断与多标签页一致性 | 使用 IndexedDB 恢复日志和独立设置版本，在一次索引事务中切换可见版本。Chromium 在写入候选前、写入后及提交后三个位置实际终止渲染进程，重开得到完整旧／新状态。Chrome、Firefox 和 WebKit 验证候选字节不符、设置读取被拒绝、缺失候选、旧标签页继续保存，以及确认取消时另一标签页已提交的冲突 | 损坏候选保留旧数据并提供重新加载或确认放弃；过期确认不会删除已提交的新版本。不声称浏览器提供系统断电或磁盘故障下的持久写入保证 |
| Plex 账号登录 | 真实 Plex 已签发登录 PIN，官方授权页面可打开。模拟接口验证回调、服务器发现、会话归属和服务令牌转交。[Plex 开发者文档](https://developer.plex.tv/pms/) | 用户在官方页面同意后，实际账号的服务器发现、授权及播放仍待验收 |
| 本机 Plex Media Server | 官方 Plex 1.43.5.11079 容器采用临时曲库、单独网络和本机端口。通过官方允许的本地网络访问，Groovebox 连接接口返回 201，空音乐库列表返回 200。[Plex 本地网络认证](https://support.plex.tv/articles/200890058-authentication-for-local-network-access/) | 未认领的临时实例在创建音乐库时持续返回 HTTP 400，并报告服务器仍在初始化。曲目、封面、音频字节范围和真实账号播放待验收 |
| SMB v2/v3 | 通过实际 SMB2 和要求加密的 Samba SMB3 服务验证认证、目录、Range 和歌词 | 独立 NAS 型号兼容性待实测 |
| SMB 目录封面和离线封面 | Chrome、Firefox 和 WebKit 用真实 SMB2 和 Samba 4.21.9 加密 SMB 3.1.1 验证 PNG/JPEG 读取、刷新替换及播放不中断。关闭 SMB 服务并断网刷新后，离线封面和原音频的 SHA‑256 与源文件一致。后端验证 MIME 内容、安全大小限制和会话隔离。[原版目录教程](https://music.caij.xyz/zh/faq/) | 实体 NAS 设备封面待验收 |
| 离线歌曲 | Chrome、WebKit 和 Firefox 验证网盘失联后可播放本地副本和删除副本 | 浏览器容量差异及离线队列场景 |
| LRC、VTT、逐字歌词、歌词定位、在线匹配 | 支持 YRC、QRC、KRC 和 LRCLIB Lyricsfile 逐字同步。已用真实 LRCLIB 在浏览器显示同步歌词，并用固定响应覆盖精确匹配、候选版本、逐字定位、限流重试及刷新复用。Chrome、Firefox 和 WebKit 已验证 Jellyfin、OpenSubsonic 与本地 LRC 的多行同步译文、原文高亮及定位。[LRCLIB](https://lrclib.net/docs) · [原版多行译文](https://github.com/pure-music/PureMusic/issues/160) | 在线歌词覆盖范围及其他来源的翻译格式待比对 |
| 双击歌词播放与暂停 | 同步歌词和纯文本歌词在播放侧栏和沉浸界面均可双击切换播放状态。同步歌词可单击或按键定位。[原版双击歌词](https://github.com/pure-music/PureMusic/issues/155) | 不同系统双击间隔和移动手势待比对 |
| 手动校准歌词时间 | 提前或延后逐行、逐字和迷你同步歌词，点击跳转使用相同偏移。Chrome、Firefox 和 WebKit 验证与 LRC 文件内偏移叠加、刷新保留和备份恢复。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v3.8.0) | 网页采用全局设置和 100 毫秒按钮，原版作用范围和步长待对照 |
| 歌词字体粗细 | 可在外观设置选择默认、常规、中等或粗体。Chrome、Firefox 和 WebKit 验证迷你歌词、歌词侧栏及沉浸界面，逐字高亮保留，设置可随备份恢复。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v4.4.2) | 原版字重选项待实机核对 |
| 歌词专注模式 | 沉浸播放可隐藏播放控件、进度条和歌词工具，保留音频播放及歌词定位。Chrome、Firefox 和 WebKit 验证键盘操作，移动 Chrome 和 Firefox 验证触控。按 Esc 先恢复控件，退出沉浸页自动关闭。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v4.4.2) | 原版触发位置和关闭后是否记忆待实机核对 |
| 清理歌词缓存 | 音频设置可清除在线匹配和远程歌词缓存。三个浏览器验证停止旧请求后不会写回缓存，导入歌词、离线音频和当前播放仍可用。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v2.1.1) | 网页暂留当前显示到停止或切歌，原版清理后对当前显示的处理待实机对照 |
| 浏览其他歌词版本 | 有在线匹配后可直接搜索 LRCLIB 候选，按专辑、艺人和时长选定再切换。Chrome、Firefox 和 WebKit 验证取消保留原版本、已关闭窗口的结果失效和服务端限流。[LRCLIB 搜索文档](https://lrclib.net/docs.txt) | 原版多歌词来源的实际服务名单仍待核实 |
| 媒体服务器歌词版本 | OpenSubsonic 返回多个主歌词版本时，支持按语言选择同步或纯文本歌词。Chrome、Firefox 和 WebKit 连接真实 Navidrome 0.64.2，通过含三个语言内嵌歌词的 MP3 验证英语同步、法语纯文本、日语逐字歌词及刷新保留选择。模拟接口另验证重排、在线匹配切换、未关联译文隔离及更换来源后的旧弹窗隔离。[OpenSubsonic 歌词格式](https://opensubsonic.netlify.app/docs/responses/structuredlyrics/) | 其他服务器的多版本及与原版的具体选择行为待验收 |
| 沉浸歌词手动浏览 | 手动滚动时保留浏览位置，当前句仍随播放高亮。网页版停止交互约 3 秒后恢复跟随，主动选择歌词可立即定位。Chrome、Firefox 和 WebKit 验证真实播放进度与歌词滚动。[原版手动浏览歌词](https://github.com/pure-music/PureMusic/issues/51) | 原版自动恢复的具体时长待比对 |
| 歌词页艺人入口 | 歌词侧栏和沉浸界面均左对齐歌名与艺人，可打开艺人详情并持续播放。Chrome、Firefox 和 WebKit 验证多艺人链接和播放状态，另验证移动触控。[原版歌词页排版及艺人入口](https://github.com/pure-music/PureMusic/issues/150) |
| 从播放页打开歌词 | 点击同步歌词预览，或在封面与预览区域右滑，即可打开完整歌词。三个浏览器验证歌词跟随、跳转和播放连续性。[原版歌词入口](https://github.com/pure-music/PureMusic/issues/70) |
| 再次选择正在播放的歌曲 | 可单独开启再次选择正在播放的歌曲时打开播放详情。Chrome、Firefox、WebKit 验证正在播放的条目保留进度和队列，同一歌曲在列表的其他位置仍可独立选中。[原版重复选择行为](https://github.com/pure-music/PureMusic/issues/95) |
| 睡眠定时 | 播放侧栏和沉浸界面支持设定时长、倒计时和取消。可立即暂停或等当前歌曲播完。Chrome、Firefox、WebKit 验证本地音频和 DLNA 控制流程。真实 GMediaRender 软件接收器验证到期暂停和等待歌曲自然结束。[原版睡眠定时](https://github.com/pure-music/PureMusic/issues/80) | 倒计时限当前页面，实体 DLNA 接收器待验收 |
| 切到后台时暂停 | 音频设置可开启。Chrome、Firefox 和 WebKit 用真实音频验证隐藏事件后暂停、进度与队列保留、返回可手动续播。模拟 DLNA 接口验证发送暂停命令。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v3.8.0) | 页面隐藏事件用自动化模拟，原版默认设置和手机实际锁屏行为待对照 |
| 触屏长按定位当前歌曲 | 播放栏可长按定位当前曲目。Chrome 移动端实测长按和松手焦点，Chrome 与 Firefox 移动端验证拖动取消、排序后的准确条目和播放连续性。[原版当前歌曲定位](https://github.com/pure-music/PureMusic/issues/173) |
| 主题、自定义背景、沉浸播放、均衡器、ReplayGain、屏幕常亮 | 支持沉浸下滑退出并恢复歌词滚动、歌词模糊、播放按钮样式、原声设置和增益余量。Chrome 验证常亮请求和暂停释放 | 背景模糊和不透明度已验证，原版其他主题选项与播放器细调待比对 |
| 顶部工具栏 | 「设置 → 外观」可选择工具栏是否固定。Chrome、Firefox、WebKit 验证桌面和手机宽度的滚动位置、刷新及恢复备份。[原版工具栏设置](https://github.com/pure-music/PureMusic/issues/165) |
| 均衡器配置 | 「设置 → 音频」可命名保存、更新、切换及删除配置；新配置采用已核实的十段和内置预设，旧五段配置保留原频率和增益。Chrome、Firefox、WebKit 验证独立开关、切换时当前音频继续播放、滤波参数更新、刷新与备份恢复。[原版 5.4.0 发布记录](https://github.com/pure-music/PureMusic/releases/tag/v5.4.0) | 官方 5.5.0 Windows 频段、八组预设和开关行为已实测；底层滤波器 Q 与输出响应仍待逐样本比对 |
| 曲目及专辑 ReplayGain | Chrome、Firefox 和 WebKit 使用带增益标签的音频验证按专辑统一增益、旧导入曲目补读、缺少专辑标签时回退到曲目增益及刷新恢复设置。真实 Ogg Opus 已验证本地导入、HTTP Range 读取路径、R128 曲目及专辑标签优先，缺少适用 R128 标签时回退到 ReplayGain。[原版曲目、专辑模式](https://github.com/pure-music/PureMusic/issues/149) · [Opus R128 标签规范](https://www.rfc-editor.org/rfc/rfc7845.html#section-5.2.1) | 原版固定场景的参数及生效条件待核对 |
| Opus 文件头增益 | 运行时探测浏览器的解码行为。对确认忽略该增益的桌面浏览器，验证完整的本地或离线单流 Ogg Opus 后再补偿，正增益同时要求通过削波检查。Chrome、Firefox 和 WebKit 以实际 PCM 验证了正负增益及原始音源连续性。[Opus 文件头规范](https://www.rfc-editor.org/rfc/rfc7845.html#section-5.1) | 串流、移动设备和链式 Ogg 的文件头增益仍依赖浏览器 |
| 迷你播放器和本地来源可见性 | 设置可即时切换迷你播放器和隐藏本地来源入口。已导入曲目仍可播放，两项设置都随备份恢复 | 原版迷你播放器细节待比对 |
| 滚轮调音量 | Chrome、Firefox 和 WebKit 验证了实际滚轮方向、音量边界及刷新后恢复。网页版采用每次 5 个百分点。[滚轮音量](https://github.com/pure-music/PureMusic/issues/182) · [方向修正](https://github.com/pure-music/PureMusic/issues/186) | 不同触控板灵敏度待比对 |
| 播放键按封面取色 | 外观设置可开启取色，按播放器背景调整对比度，封面加载失败时恢复主题颜色。支持现有按钮样式及设置备份。[原版播放键取色](https://github.com/pure-music/PureMusic/issues/166) | 原版横屏各主题的取色策略待比对 |
| 按来源隐藏或恢复曲库 | Chrome、Firefox 和 WebKit 连接两个独立的真实 HTTPS WebDAV 音乐来源，验证单独隐藏、刷新后持久化、独立显示、搜索及分类、下载副本播放。恢复显示复用已有索引，真实服务的目录请求和连接次数保持一致。另验证本地来源和备份恢复。[原版来源可见性](https://github.com/pure-music/PureMusic/issues/162) | 原版历史和已建歌单视图的可见性规则待比对 |
| 一键刷新已索引来源 | 「全部歌曲」依次刷新已连接且可见的云端目录，支持取消并保留失败来源的索引。用两个真实 WebDAV 来源验证了部分刷新、隐藏来源跳过和已扫描目录的新增及改名。[原版一键刷新](https://github.com/pure-music/PureMusic/issues/153) | 使用真实个人网盘验证大目录 |
| 网盘扫描深度和起始目录 | 从根目录或当前设定的目录向下扫描四层。Chrome、Firefox 和 WebKit 用模拟百度接口验证了不访问超出深度的子目录、已独立收录的深层目录可刷新，以及按已确认的目录变化清理索引。[原版目录设置](https://music.caij.xyz/zh/faq/) | 原版是否把起始目录算作一层与真实网盘大目录仍待对照 |
| 按来源解析文件名 | 网盘、WebDAV 和 SMB 可单独切换文件名模式和规则，按文件名提取曲名、艺人和编号，并可从「专辑-艺人」目录补齐信息。Chrome、Firefox 和 WebKit 用真实 HTTPS WsgiDAV 和 SMB2 验证独立规则、重新扫描、歌词、HTTP Range 和歌单引用。SMB 另验证切回内嵌标签后曲目 ID 保留及源文件字节未变化；百度测试使用模拟接口。[原版文件名教程](https://music.caij.xyz/zh/faq/) | 个人网盘的规则设置仍待验收 |
| WebDAV 目录封面 | Chrome、Firefox 和 WebKit 用真实 HTTPS WsgiDAV 验证同目录 PNG/JPEG、内嵌封面优先、无效 PNG 可回退到 JPEG、子目录隔离，以及重扫更新、移除当前封面时音频继续播放。认证封面随来源会话授权。[原版目录封面教程](https://music.caij.xyz/zh/faq/) | 其他远程文件来源待验收 |
| 百度网盘目录封面 | 对同目录 PNG/JPEG 发放会话限用的图片链接，内嵌封面优先。模拟百度接口的后端测试验证跨页发现、来源会话隔离、刷新令牌及重启恢复。Chrome、Firefox 和 WebKit 验证重扫切换和移除当前封面时播放继续。[原版目录封面教程](https://music.caij.xyz/zh/faq/) | 个人百度网盘授权后的真实验收待补 |
| 已下载曲目的认证封面 | Chrome、Firefox 和 WebKit 验证新保存的曲目保留其百度或 WebDAV 同目录封面。真实 HTTPS WsgiDAV 停止后断网刷新，仍能显示该曲目的封面并播放与原始字节一致的音频。其他曲目和会话缓存隔离，移除下载会清理对应封面 | 百度使用模拟接口，早期已下载曲目需重新保存才能补齐封面 |
| 简体中文、英文、日文和韩文 | 可在设置中即时切换并随备份恢复。Chrome、Firefox 和 WebKit 验证了播放中切换语言和日文界面的离线重载 | 第三方服务的部分错误详情会按原文显示 |
| 投屏 | 已接入浏览器 Remote Playback、Safari AirPlay 和 DLNA。在隔离 Docker 网络使用真实 GMediaRender 0.3 软件接收器验证设备发现、WAV 解码、进度、跳转、暂停、继续和停止 | 实体接收设备、音源兼容性及原版投屏协议待比对 |
| 会员与订阅行为 | 待核对 | 确定 Web 对齐范围及产品配置，需独立支付部署和测试 |
| CarPlay、原生系统音乐资料库 | 纯 Web 阶段之外 | 如进入原生阶段，单独按目标设备验收 |

## 本网页新增功能

| 用户要求 | 验收 |
| --- | --- |
| 歌单提前缓存和下载 | 已验证一次性预缓存只处理当前快照，新增成员需再次触发；另保留持续自动补齐模式。三个浏览器验证删除副本时取消旧预缓存任务，防止重新下载。容量淘汰后的曲目不会被后台反复填回，刷新后仍有效。ZIP 保留原始文件名与原始字节。[原版歌单下载](https://github.com/pure-music/PureMusic/issues/33) |
| 缓存管理与固定离线副本 | 歌曲、图片、歌词及全部缓存分别统计和清理。歌曲默认 1024 MiB、最低 200 MiB，图片默认 250 MiB、最低 50 MiB；音频与图片按实际字节和最近访问淘汰。三个浏览器验证 v2 离线音频升级为固定副本、真实 200 MiB 容量下的淘汰、跨标签页清理与迟到请求不写回。清理后暂停自动写入，手动恢复；固定下载、导入音乐和正在播放的音频保留，原音频字节一致。图片的 MiB 单位为网页明确约定；原版只核实其容量标签和最低值，未进行图片容量压力对照。原版界面缓存总量有重复计数，网页按实际保存字节统计 |
| 曲库流派分类 | Chrome、Firefox 和 WebKit 使用带真实流派标签的 M4A 验证多流派、未分类、刷新保留及分类内播放。支持自定义分隔符和完整标签例外，同一规则应用于曲库、搜索和离线筛选，可随备份恢复。媒体服务器流派字段和云端文件标签有接口测试 |
| 曲库艺人分类 | Chrome、Firefox 和 WebKit 验证自定义艺人分隔符、完整艺人名例外、搜索、离线筛选和备份恢复，保留歌曲原始署名。[原版艺人分类设置](https://github.com/pure-music/PureMusic/issues/131) |
| 媒体服务器的合作艺人分类 | Chrome、Firefox 和 WebKit 用真实 Navidrome 0.64.2 验证一首合作曲目出现在各艺人分类中，播放界面保留原署名。已验证自定义分隔符和完整署名例外优先、刷新后规则有效。接口测试覆盖 OpenSubsonic、Emby、Jellyfin 和 Kodi 的结构化艺人字段。[OpenSubsonic 曲目结构](https://opensubsonic.github.io/docs/responses/child/) | 已保存的旧曲目在重新扫描后可补齐艺人字段。其他服务的实际分类结果和 Plex 专辑级流派待验收 |
| 曲库专辑分类 | 按专辑艺人标签区分同名专辑，缺少标签时默认合并。设置可启用按歌曲艺人分组，并随备份恢复。三个浏览器验证按专辑艺人排序、中文拼音、同艺人按专辑标题与未知艺人排在末尾。[原版专辑艺人设置](https://github.com/pure-music/PureMusic/issues/130) |
| 专辑艺人入口 | 专辑详情中的专辑艺人可打开各自的艺人页。Chrome、Firefox 和 WebKit 验证即使发布署名艺人未在单曲上署名，也能经艺人页返回完整专辑并持续播放。[原版专辑艺人入口](https://github.com/pure-music/PureMusic/issues/67) | 媒体服务返回的结构化多艺人署名待核对 |
| 专辑网格列数 | Chrome、Firefox 和 WebKit 验证了专辑总览与艺人详情各自设置列数、窄屏布局、跨刷新与备份恢复，以及从艺人详情打开完整专辑。[原版独立网格设置](https://github.com/pure-music/PureMusic/issues/152) |
| 已下载音乐、扫描、搜索、分类和删除 | 已验证递归扫描、本地歌词、搜索和来源／艺人／专辑／流派筛选、删除缓存和导入记录，保留物理原文件。Chrome、Firefox 和 WebKit 均在断网并停止服务器后刷新页面，验证已缓存音频播放 |
| 本地同名录音及同名目录 | Chrome、Firefox 和 WebKit 用实际设备文件验证不同录音可保留两首或明确替换、相同字节去重、歌单收藏和播放引用保持。同名目录可更新或另建独立曲集；音频、目录封面及艺人图片保存独立快照。另验证同尺寸同修改时间、跨标签页冲突、空间不足的原子回滚，以及旧数据库被其他页面占用后的恢复 | 浏览器不提供绝对路径，同名目录需用户明确区分；旧版已被设备改写的历史字节无法恢复 |
| 本地目录重扫歌词 | Chrome、Firefox 和 WebKit 验证移除目录 LRC 后清理旧歌词并回退到内嵌歌词，包括旧版无来源标记的记录。明确手动导入的歌词保留；已替换录音的旧在线匹配和未完成查询失效 | 未选择的新目录无法自动读取，需再次选择目录 |
| 单曲另存原始音频 | Chrome、Firefox 和 WebKit 用真实 HTTPS WebDAV 验证直接下载 64 MiB 的 WAV，源文件与下载文件 SHA‑256 一致。另验证已缓存的小曲目仍可断网另存 | 浏览器可能按容器 MIME 调整扩展名 |
| 曲库移除和加回 | Chrome、Firefox、WebKit 验证可移除单首或多首曲库歌曲，可勾选一并删除播放器副本。刷新、重扫和加回曲库保留对应状态。百度及 Google Drive 用模拟接口验证仅执行读取请求，本地导入用真实音频验证 |
| 本地目录封面 | 无内嵌封面的曲目使用同目录 `cover.png`、`cover.jpg` 或 `cover.jpeg`。Chrome、Firefox 和 WebKit 验证原图片字节、内嵌封面优先、不同目录隔离、重扫更新或移除图片、断网刷新显示和不中断播放。[原版文件夹封面教程](https://music.caij.xyz/zh/faq/) | 个人网盘目录封面待验收 |
| 本地艺人照片目录 | 从所选本地来源的 `artist` 子目录按艺人名匹配 PNG 或 JPEG，照片优先于在线匹配。三个浏览器验证艺人列表和详情、断网刷新、重扫替换以及损坏照片回退。[原版艺人照片教程](https://music.caij.xyz/zh/faq/) |
| WebDAV 和 SMB 艺人照片目录 | Chrome、Firefox 和 WebKit 用真实认证 HTTPS WsgiDAV 和 SMB2 验证 `artist` 目录、名称规范化、无效图片回退及刷新更新。另验证最多三个来源并发、读取失败延迟重试及恢复联网立即重试。多个来源有同名艺人时，可通过来源筛选消除歧义，未完成读取的来源保留待确认状态。未认证请求返回 404。[原版艺人照片教程](https://music.caij.xyz/zh/faq/) | 远程艺人照片需要在线连接，其他远程来源及实体 NAS 待实现或验收 |
| 兼容播放切回原件 | Chrome、Firefox、WebKit 用真实 WAV 验证切回原始字节，保留进度、播放状态和队列位置。播放器单元测试验证随机顺序保持。真实 APE 无法原生解码时验证恢复兼容音频。 | 浏览器和输出设备仍决定最终采样率和声道 |
| 在线封面 | Chrome、Firefox 和 WebKit 已验证在专辑详情查找并显示真实 MusicBrainz 和 Cover Art Archive 封面。歌曲和专辑均可手动查找、按设置自动匹配和刷新复用。有效原封面优先，合集使用专辑艺人。近期封面可随已下载歌曲离线显示，已在三个浏览器通过断网与停服务回归 |
| 在线歌词搜索和版本选择 | Chrome、Firefox 和 WebKit 验证已有歌词时可手动匹配、切回原歌词、复用在线版本及刷新恢复。三者均通过真实 LRCLIB 仅按《晴天》歌名搜索并显示所选同步歌词。自动匹配仍只查缺失歌词。[原版相关反馈](https://github.com/pure-music/PureMusic/issues/191) |
| 自定义 LRCLIB 与 HisAtri 歌词接口 | Chrome、Firefox 和 WebKit 通过实际播放器服务与隔离歌词服务验证 JSON 和 LRC、加密配置重启恢复、凭据不进入浏览器备份、原有歌词优先、手动覆盖和切回、配置版本与曲目变更后旧查询停止、各服务独立限流。自定义无结果时，只在明确提交后搜索公开 LRCLIB | 第三方真实部署及原版内置接口优先级仍待对照 |
| 自定义 HisAtri 专辑封面与艺人照片 | Chrome、Firefox 和 WebKit 通过实际播放器服务与隔离图片服务验证独立开关、原图片优先、接口加密和重启恢复、图片过期及一次重试、配置改变后的请求取消。真实 WebDAV 两首同专辑歌曲验证地址轮换后，断网且关闭两个服务，已下载歌曲仍保留原音频和下载时的封面字节 | 第三方真实部署、原版图片缓存容量及清理机制仍待对照 |

原版资料 [官网](https://music.caij.xyz/en/) · [开发者功能说明](https://github.com/pure-music/PureMusic/blob/main/README_ZH.md) · [App Store 5.4.1 版本记录](https://apps.apple.com/us/app/cottonmusic/id6752617064?platform=watch) · [115 第三方接口维护公告](https://115.com/115/T976421.html)

基线交互记录 [定位当前歌曲](https://github.com/pure-music/PureMusic/issues/173) · [打开播放详情](https://github.com/pure-music/PureMusic/issues/198) · [歌单自定义排序](https://github.com/pure-music/PureMusic/issues/144) · [导入 M3U](https://github.com/pure-music/PureMusic/issues/169) · [流派分隔符](https://github.com/pure-music/PureMusic/issues/131) · [批量读取音频标签](https://github.com/pure-music/PureMusic/issues/184)

## Cotton Music 5.5.0 新增功能

| 功能 | 当前验证 | 待验收或补齐 |
| --- | --- | --- |
| 专辑歌曲播放进度 | 在「设置 → 音频」开启后，专辑详情按曲目显示最近播放位置。Chrome、Firefox、WebKit 验证了进度随播放及跳转更新、不同歌曲独立记录、刷新恢复和播完显示 100%。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v5.5.0) | 原版进度取整、保留策略及外部投屏进度待核对 |
| 网盘直连模式 | 可单独开启一个网盘的直连模式，从目录播放，无需扫描。实际开始播放的歌曲出现在首页最近播放。Chrome、Firefox、WebKit 用模拟百度及 Google Drive 接口验证了各来源独立设置、刷新恢复、隐藏规则及退出模式后复用旧索引。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v5.5.0) | 各网盘的个人账号待授权实测 |
| 按艺人关闭自动图片匹配 | 艺人详情可暂停该艺人的在线照片和专辑封面自动查询。Chrome、Firefox 和 WebKit 验证关闭后仍可手动查询、刷新保留设置、重新启用后可继续自动查询。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v5.5.0) | 原版刮削的具体字段和匹配优先级待实机核对 |
| 十段均衡器、内置预设与独立开关 | 官方 5.5.0 Windows 实际界面核实 32、64、125、250、500、1000、2000、4000、8000、16000 Hz，±12 dB、1 dB 步进；八组预设曲线、默认关闭、关闭保留曲线、重置保持开关及重启保存均已实测。网页在三个浏览器验证实际 AudioNode 路由／增益、预设、备份和旧五段配置切换，音源与播放位置保留 | 网页采用现有 Web Audio 滤波器与增益余量；原版实际滤波 Q 及逐样本输出未核实，不能将控件参数通过当作 DSP 完全一致 |
| ReplayGain 固定场景 | 官方 5.5.0 Windows 实际界面只有关闭、曲目、专辑，已验证选项和重启保留；网页已有对应开关和两模式 | 原版输出增益和其他平台额外场景仍待实测。[原版发布记录](https://github.com/pure-music/PureMusic/releases/tag/v5.5.0) |

## 邻近公开发行包的核对线索

下列设置标签来自校验过的官方 5.4.2 Windows、Android 资源，尚未算作 5.4.1 运行行为通过。共享标签可能用于其他平台或受会员资格限制，仍需实际界面及操作验证。[官方发行包](https://github.com/pure-music/PureMusic/releases/tag/v5.4.2)

另已在隔离 Linux JVM/Xvfb 中运行未修改的官方 Windows 5.4.2 应用 JAR，确认新配置的歌单默认按创建时间倒序；网页已按此调整并保留旧偏好。重命名、增减成员会改变歌单修改时间，手动拖动曲目顺序不会；网页已实现对应规则和歌单修改时间排序。全新参考配置的歌曲列表默认按标题排序，网页也已实现，并保留旧用户偏好。该兼容运行环境不是官方 Linux 安装包，也不等同于 5.4.1 或原生 Windows 验收。

同一参考环境实测歌曲年份按升序、未知年份在前。WebDAV 的添加和修改日期都采用文件修改时间，重扫会更新两者；真实 1960 年的负时间保留，缺失值和 1970 年零值并列。网页已实现这些排序；Chrome、Firefox 和 WebKit 用真实 HTTPS WebDAV 验证文件日期、重扫、标签年份、显示与播放队列、WebDAV 跨配置备份和本机完整备份。本地实际文件验证时间更新不会轮换未改变的音频地址。其他媒体来源的添加时间仍待对照，未以扫描时间补造。

同一新配置中，内置艺人图片引擎、歌曲封面自动匹配、内置歌词引擎及专辑封面代替艺人照片开关均已开启，界面另说明会员条件及回退关系。歌曲缓存默认 1024 MB，图片缓存默认 250 MB，可分别清理歌曲、图片和歌词，下载管理另有入口。这些是实际界面默认值；未登录账号，也未验证远端查询、在线下载或会员能力。

| 已确认的设置线索 | 当前网页差距与待核对内容 |
| --- | --- |
| 自定义歌词、专辑封面及艺人封面 API，包含请求头配置 | 网页已实现歌词和图片接口配置及查询。隔离本地服务已验证参考版 LRCLIB 使用 GET 和歌曲、艺人、专辑、秒数参数，JSON 同步歌词可显示；HisAtri 使用 GET 和标题、艺人、专辑参数，文本 LRC 可显示，404 显示未找到。HisAtri 图片接口可显示 JPEG，区分艺人与专辑查询，配置的请求头确实发送。内置接口优先级及外部提供商真实部署仍待验收 |
| 逐字歌词四种模式与全屏歌词居中选项 | 原版静态界面确认全屏居中仅改变右栏歌名、艺人和歌词的水平对齐，默认关闭；网页已实现，36 项浏览器及移动端回归验证切换、滚动、逐字和播放状态。签名 Apple Silicon 5.4.2 原版在隔离 macOS 配置实际播放，200 帧核实关闭、默认透明度渐变、匀速和准确滑动。网页已加入四模式，保留明确的词结束时间，三个浏览器验证词间空档的准确滑动回退、偏移、双视图、连续播放和备份。透明度用最接近像素测量的 smoothstep 拟合，原内部插值代码、长行换行及 RTL 尚未完全对照 |
| 艺人图片引擎与歌曲封面自动匹配为独立设置 | 网页已拆分开关并按参考界面设置新配置默认值，保留旧偏好；Chrome、Firefox 和 WebKit 验证独立控制、取消自动请求、迟到响应及备份恢复。参考界面确认照片引擎关闭时才启用专辑封面回退；兼容运行环境中未观察到本地内嵌专辑封面成功回退，远端查询与会员权限仍待验收 |
| 下载管理和缓存管理分别列出，缓存区分歌曲、歌词和封面 | 原版实测歌单预缓存为一次性操作，新成员需再次触发，本地曲目不重复复制。歌曲默认 1024 MiB、最低 200 MiB，图片界面默认 250 MB、最低 50 MB；歌曲超额按最近访问淘汰。网页已实现独立的一次性预缓存、持续预缓存、缓存用量与容量控制和分类／全部清理，三个浏览器验证固定副本和导入音乐不被清除。原版清理后的系统退出行为为原生范围，网页留在当前页面；图片压力下的原版单位仍待实测 |
| Android 资源出现十频段 EQ、独立开关及内置场景 | 网页已依据实际 5.5.0 Windows 界面实现十频段、八组预设和独立开关，并保留旧五段曲线；不能把该版本或 Android 共享标签当作 5.4.1 各平台已支持的证明 |
