# ComfyUI Easy Bridge

## 核心功能

提供一个简化的 API ，用于将 ComfyUI 导出的 API 格式工作流 JSON 进行封装，把指定的节点key的输入标记为一个别名，在该项目提供的API中只需要传入对应的别名+值，即可向 ComfyUI 发起完整的工作流运行接口调用

### 案例

原始 ComfyUI API JSOn 文件(部分):

```json
{
  "29": {
    "inputs": {
      "filename_prefix": "Krea2_turbo",
      "images": [
        "30:8",
        0
      ]
    },
    "class_type": "SaveImage",
    "_meta": {
      "title": "保存图像"
    }
  },
  "49": {
    "inputs": {
      "aspect_ratio": "16:9 (Widescreen)",
      "megapixels": 1,
      "multiple": 8
    },
    "class_type": "ResolutionSelector",
    "_meta": {
      "title": "分辨率选择器"
    }
  },
  "30:19": {
    "inputs": {
      "value": "生成人物角色正面、侧面、背面三个视角的全身图\n\n要求：纯白色背景、自然站立，双臂自然下垂\n以下为角色描述：\n\n日本动画风格\n头发：红色披肩散发，左侧单马尾\n眼睛：黄绿瞳\n身高：158cm\n体重：44kg\n年龄：17岁\n淡黄色长袖水手服，深灰色短裙，白色短袜，棕色皮鞋，背着黑色吉他背包，左脚大腿上有蓝色腿环，性格活泼\n"
    },
    "class_type": "PrimitiveStringMultiline",
    "_meta": {
      "title": "Text String (User Prompt)"
    }
  }
}
```

通过将`30:19`的`input`的`value`标记为 `img_desc` 后，对该项目的接口发起以下 HTTP 调用

```
POST /api/workflow/{工作流id}

{
  "img_desc": "一只橘黄色的凶猛小猫，在圆形多隔层的木制置物架上，面向镜头，生气地张开嘴，写实风格"
}
```

## 操作流程

系统默认端口: 10721W

1. 浏览器访问系统管理员页面`/admin`
2. 在系统设置中，配置 ComfyUI 的 HTTP 服务器地址 baseUrl
3. 在工作流管理中选择新增工作流，上传或粘贴`ComfyUi`导出的原始API json文件
4. 上传或粘贴JSON，并对工作流进行命名后（可自定义名称和唯一标识id，唯一标识id可在页面上选择随机生成）后，页面上会呈现一个列表，列表显示节点id、节点标题、可接受的输入字段。
5. 可以选择一个输入字段添加为参数字段，对参数字段可以设置字段标识(必填) 和 标签(可选)，配置完成即可保存

外部调用接口 `POST /api/workflow/{工作流id}` 后，根据接口传入的字段参数，解析原始的 ComfyUI API JSON，替换掉对应节点的input字段值后，对ComfyUI的`POST /prompt`接口发起调用


## 技术栈

### 后端
- node.js
- sqlite

### 前端
- vue3
- Vuetify
- TypeScript

## 参考资料

- [ComfyUI API 官方文档](https://docs.comfy.org/development/comfyui-server/comms_routes)
- [Vuetify 文档](https://next.vuetifyjs.com/zh-Hans/getting-started/installation/)