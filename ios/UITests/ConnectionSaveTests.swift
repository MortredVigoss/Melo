import XCTest

final class ConnectionSaveTests: XCTestCase {
    private let app = XCUIApplication()

    private func openSettings() {
        app.launchArguments = ["-melo-preview-section", "3", "-melo.interfaceLanguage", "zh-CN", "-AppleLanguages", "(zh-Hans)"]
        app.launch()
        let settings = app.buttons["模型连接与 API Key"]
        XCTAssertTrue(settings.waitForExistence(timeout: 12))
        settings.tap()
    }

    func testSaveKeyThenReopenAndUseConnection() throws {
        continueAfterFailure = false
        openSettings()
        app.buttons["添加 API Key 连接"].tap()
        app.buttons["自定义兼容服务"].tap()
        let endpoint = app.textFields["服务 Base URL（HTTPS）"]
        endpoint.tap()
        let fixture = ProcessInfo.processInfo.environment["MELO_CONNECTION_QA_URL"]
        if let fixture {
            XCTAssertEqual(URL(string: fixture)?.host, "127.0.0.1")
        }
        let service = fixture ?? "https://example.invalid/v1"
        endpoint.typeText(service)
        let key = app.secureTextFields.firstMatch
        key.tap()
        key.typeText("melo-ui-fixture-key")
        app.buttons["connection.save"].tap()
        let saved = app.staticTexts["API Key 已保存"]
        XCTAssertTrue(saved.waitForExistence(timeout: 5), "The saved credential needs a visible receipt alongside the account.")
        app.terminate()
        openSettings()
        XCTAssertTrue(saved.waitForExistence(timeout: 5), "Reopening must show the account just saved, even when Codex is still the default.")
        app.buttons["connection.edit"].tap()
        let model = app.textFields["模型 ID"]
        model.tap()
        model.typeText("melo-ui-fixture")
        app.buttons["connection.save"].tap()
        XCTAssertTrue(saved.exists)
        if fixture != nil {
            app.buttons["测试已保存连接"].tap()
            XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "MELO_KEY_ACCEPTED")).firstMatch.waitForExistence(timeout: 20))
            app.buttons["设为当前"].tap()
            app.terminate()
            app.launchArguments = ["-melo.interfaceLanguage", "zh-CN"]
            app.launch()
            app.buttons["从一个想法开始…"].tap()
            let composer = app.descendants(matching: .any)["chat.composer"]
            composer.tap()
            composer.typeText("Hello")
            app.buttons["发送消息"].tap()
            XCTAssertTrue(app.staticTexts["MELO_CHAT_ACCEPTED"].firstMatch.waitForExistence(timeout: 35))
        }
    }
}
