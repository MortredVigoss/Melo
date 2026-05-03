{
  "targets": [
    {
      "target_name": "dirfd_ops",
      "sources": ["native/dirfd_ops.cc"],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "dependencies": [
        "<!(node -p \"require('node-addon-api').gyp\")"
      ],
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "conditions": [
        ["OS==\"mac\"", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "NO",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "10.15"
          }
        }],
        ["OS==\"linux\"", {
          "cflags_cc": ["-std=c++17"]
        }]
      ]
    }
  ]
}
