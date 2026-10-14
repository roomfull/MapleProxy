# MapleProxy 许可范围

本仓库包含分别授权的组件。根目录的 MIT 许可不会替换第三方许可，也不会授予第三方代码原许可未授予的权利。

| 范围 | 适用许可 |
| --- | --- |
| 独立编写的 MapleProxy 代码与文档，包括 `src/`、`web/`、`examples/`、根目录 `scripts/`、`tests/` 中的原创部分 | [MIT](LICENSE)；另有许可标注的材料除外 |
| `vendor/siwc/` 中的 OpenAI DevKit 代码、文档及其修改，以及这些文件的复制或编译产物 | [Sign-in with ChatGPT DevKit Noncommercial License v1.0](LICENSE-SIWC)；该目录中另行授权的第三方材料除外 |
| npm 依赖及其他第三方材料 | 各自的许可；参见 [运行时依赖声明](THIRD_PARTY_NOTICES.md) 与 [DevKit 原始依赖声明](vendor/siwc/THIRD_PARTY_NOTICES.md) |

## DevKit 的使用限制

依据 [上游许可](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/0a36fefeb913055c8c7a1a29b63d82b96b2e841a/LICENSE) 第 1、2 条，DevKit 仅授予其定义的非商业用途权利。非商业用途包括没有预期商业应用的个人学习、实验与开发；为企业、雇主或客户的业务或商业利益进行开发、测试、分发或运行不在此授权范围内，即使不收取费用。

因此，MapleProxy 原创部分的 MIT 授权不能使包含 DevKit 的完整程序获得不受限制的商业使用权。商业使用 OpenAI 的 Contribution 需要与 OpenAI 另行签订书面协议。许可第 5 条还明确说明，代码许可不授予 OpenAI 服务访问权；账户资格、服务条款、模型权限和额度另行适用。

当前完整发行内容含有非商业组件。描述项目时，请使用“MapleProxy 原创代码采用 MIT，内含 DevKit 受非商业许可约束”，不要宣称整个发行包均为 MIT 或可以任意商用。非商业限制不符合 [OSI 开源定义](https://opensource.org/osd) 对用途不受歧视的要求。

## 修改与再分发

- 保留根目录 `LICENSE`、`LICENSING.md`、`LICENSE-SIWC` 和适用的第三方声明。
- 分发 DevKit 或其修改版本时，遵守其第 4 条：保留许可、版权及其他适用声明，在修改文件中显著标明修改，并将 DevKit 的修改按同一许可分发；分发本身也必须属于其许可允许的非商业用途。
- DevKit 来源和本地修改记录保存在 [PROVENANCE](vendor/siwc/PROVENANCE.md)。独立代码与 DevKit 修改的区分取决于实际来源，不仅取决于目录位置。
- 构建脚本会将根目录许可声明复制到 `dist/`，并在 `dist/vendor/siwc/` 保留对应 DevKit 声明；`vendor/siwc/dist/` 也保留上游许可材料。若重新打包为其他目录结构，应继续随包提供相关许可和声明。

本文解释仓库的授权安排，不修改任何许可原文。遇到解释差异，以各组件适用的许可原文为准。
