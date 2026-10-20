# tiny-tools

个人实用小工具集合。每个工具独立存放，安装方式、使用说明和开发命令见各自目录。

| 工具 | 用途 | 平台 |
| --- | --- | --- |
| [X 图片收藏](./x-media-saver/) | 一键保存 X 帖子的原图和视频，按作者归档，保留下载记录并按内容去重 | Chrome / Edge 116+ |

## 目录

```text
tiny-tools/
├── x-media-saver/          # X 图片与视频收藏扩展
│   ├── manifest.json      # 直接加载此目录即可使用
│   ├── README.md          # 安装、使用与权限说明
│   ├── scripts/           # 打包及图标生成脚本
│   ├── tests/             # 自动测试与浏览器验证
│   └── vendor/            # 随扩展附带的开源依赖及许可证
└── .github/workflows/     # 自动测试与扩展打包
```

## 使用 X 图片收藏

1. 下载或克隆本仓库：`git clone git@github.com:ID3055/tiny-tools.git`。
2. 在 Chrome 的 `chrome://extensions` 或 Edge 的 `edge://extensions` 打开「开发者模式」。
3. 点击「加载未打包的扩展程序」，选择仓库中的 **`x-media-saver`** 目录。
4. 刷新 X 页面，点击帖子操作栏中的保存按钮；**Shift + 点击**可强制重新下载。

详细说明见 [x-media-saver/README.md](./x-media-saver/README.md)。

## 开发与打包

在仓库根目录运行（需要 Node.js 20+、Python 3）：

```sh
npm --prefix x-media-saver test
npm --prefix x-media-saver run check
npm --prefix x-media-saver run pack
```

扩展无需安装 npm 依赖或编译。打包输出为 `x-media-saver/dist/x-image-saver.zip`。
GitHub Actions 会在相关代码更新时运行测试并生成 ZIP，可在成功的工作流运行页面下载 `x-media-saver` 构建产物。

## 添加工具

在根目录新建一个简短、明确的目录（例如 `another-tool/`），包含自己的 README、源码和必要的测试，再更新上面的工具列表。各工具独立管理依赖和版本；下载文件、测试产物及本地配置不提交到仓库。
