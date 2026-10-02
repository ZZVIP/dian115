# 示例插件 SDK

示例插件共用的 Go 模块，模块路径 `example.com/dian115-plugin-sdk`。

## 包含什么

- `pluginjson`：体积友好的 JSON 读写。宿主拒绝链接 `encoding/json` 的模块（它会让模块
  多出约 1 MB，而这份开销会乘到每个已加载插件上），所以插件读字段、拼响应都走这里。
  它不使用反射，也不使用结构体标签。

## 怎么用

插件通过相对 `replace` 引用它，改一处两个示例同时生效：

```
require example.com/dian115-plugin-sdk v0.0.0

replace example.com/dian115-plugin-sdk => ../sdk
```

```go
import "example.com/dian115-plugin-sdk/pluginjson"

method := pluginjson.Text(pluginjson.Field(request, "method"))
```

## 注意

**`../sdk` 是示例之间的相对引用。** 如果你只把某个示例目录单独复制走，构建会失败：
要么把 `sdk/` 一起带上，要么把这份 `pluginjson` 复制进自己的插件目录——它是自包含的，
没有外部依赖。插件正式发布时，也应把它当作自己的代码一起放进包里，而不是依赖运行环境
里恰好存在这份 SDK。

## 验证

```bash
go test ./pluginjson/
```

测试直接和 `encoding/json` 对拍：这个包写出的内容必须能被真实解码器读成同一个值，它读
出的内容也必须和真实解码器一致。
