# 通过 Windows UI Automation 操作官方 Codex 客户端的聊天模式。
# 只使用已登录客户端的可见界面，不读取登录凭据，也不调用未公开的网络接口。
Add-Type -AssemblyName UIAutomationClient
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Send-Result($value) {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $value -Compress -Depth 8))
}

# 定位官方客户端主窗口；没有运行时通过系统登记的应用入口启动。
function Find-ChatWindow([bool]$allowLaunch) {
    $attempts = 1
    if ($allowLaunch) { $attempts = 30 }
    for ($i = 0; $i -lt $attempts; $i++) {
        $processes = @(Get-Process -Name 'ChatGPT' -ErrorAction SilentlyContinue)
        foreach ($process in $processes) {
            if ($process.MainWindowHandle -eq [IntPtr]::Zero) { continue }
            $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
            if ($null -eq $window -or $window.Current.Name -ne 'ChatGPT') { continue }
            $document = $window.FindFirst(
                [System.Windows.Automation.TreeScope]::Descendants,
                (New-Object System.Windows.Automation.PropertyCondition(
                    [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'RootWebArea')))
            if ($null -ne $document) { return $window }
        }
        if ($i -eq 0 -and $allowLaunch) {
            $installed = @(Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex_*!App' })
            if ($installed.Count -ne 1) { throw '未找到唯一的官方 Codex 客户端安装入口' }
            Start-Process -FilePath 'explorer.exe' -ArgumentList ('shell:AppsFolder\' + $installed[0].AppID)
        }
        Start-Sleep -Milliseconds 500
    }
    throw '官方 Codex 聊天窗口不可用'
}

# 依控件类型和准确名称定位，避免同名侧栏文字误触。
function Find-Named($window, $name, $controlType) {
    $nameCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::NameProperty, $name)
    $typeCondition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)
    $condition = New-Object System.Windows.Automation.AndCondition($nameCondition, $typeCondition)
    return $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
}

# 点击按钮；官方客户端在生成刚结束时仍在重绘，按钮会短暂处于不可用状态，
# 直接 Invoke 会抛“无法识别的错误”，所以每轮都重新定位、等它可用再点。
function Invoke-Button($window, $name) {
    $lastError = ''
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $buttons = Find-Named $window $name ([System.Windows.Automation.ControlType]::Button)
        if ($buttons.Count -lt 1) {
            $lastError = '找不到按钮'
            Start-Sleep -Milliseconds 200
            continue
        }
        $button = $buttons[0]
        # 生成结束瞬间按钮可能短暂不可用，等它就绪再点
        $enabled = $false
        for ($i = 0; $i -lt 10; $i++) {
            try { $enabled = $button.Current.IsEnabled } catch { $enabled = $false }
            if ($enabled) { break }
            Start-Sleep -Milliseconds 100
            $refind = Find-Named $window $name ([System.Windows.Automation.ControlType]::Button)
            if ($refind.Count -lt 1) { $enabled = $false; break }
            $button = $refind[0]
        }
        if (-not $enabled) {
            $lastError = '按钮不可用'
            continue
        }
        try {
            $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $pattern.Invoke()
            return
        } catch {
            # 元素在重绘中被替换时会失败，下一轮重新定位后再试
            $lastError = $_.Exception.Message
            Start-Sleep -Milliseconds 200
        }
    }
    throw ('按钮点击失败：' + $name + '（' + $lastError + '）')
}

# 在指定名称的分组内按名称和类型定位，避免同名控件散落在页面别处时被误触。
function Find-InGroup($window, $groupName, $name, $controlType) {
    $result = New-Object 'System.Collections.Generic.List[object]'
    $groups = Find-Named $window $groupName ([System.Windows.Automation.ControlType]::Group)
    foreach ($group in $groups) {
        $nameCondition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty, $name)
        $typeCondition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType)
        $condition = New-Object System.Windows.Automation.AndCondition($nameCondition, $typeCondition)
        $hits = $group.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
        foreach ($hit in $hits) { $result.Add($hit) }
    }
    return $result.ToArray()
}

# 等待控件出现再返回；官方客户端是网页异步渲染，固定等待容易读到还没画完的界面。
# $groupName 为空串时在全窗口范围内查找。
function Wait-Named($window, $groupName, $name, $controlType, $timeoutMs) {
    $deadline = [DateTime]::UtcNow.AddMilliseconds($timeoutMs)
    while ([DateTime]::UtcNow -lt $deadline) {
        $hits = @()
        if ($groupName) {
            $hits = @(Find-InGroup $window $groupName $name $controlType)
        } else {
            $hits = @(Find-Named $window $name $controlType)
        }
        if ($hits.Count -ge 1) { return $hits }
        Start-Sleep -Milliseconds 120
    }
    return @()
}

# 从真实对话区读取角色与文本；同一 JSON 被网页拆成多个文字节点时按原顺序拼接。
function Read-Conversation($window) {
    $groups = Find-Named $window '对话' ([System.Windows.Automation.ControlType]::Group)
    # 新聊天还没有消息时，官方页面尚未创建对话区。
    if ($groups.Count -eq 0) { return @() }
    if ($groups.Count -ne 1) { throw '无法唯一定位官方聊天对话区' }
    $condition = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Text)
    $nodes = $groups[0].FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
    $messages = New-Object 'System.Collections.Generic.List[object]'
    $role = ''
    $body = New-Object System.Text.StringBuilder
    foreach ($node in $nodes) {
        $name = [string]$node.Current.Name
        if ($name -eq '你说：' -or $name -eq 'ChatGPT 说：') {
            if ($role) { $messages.Add(@{ role = $role; text = $body.ToString() }) }
            if ($name -eq '你说：') { $role = 'user' } else { $role = 'assistant' }
            [void]$body.Clear()
            continue
        }
        if ($name -eq 'ChatGPT 可能会出错。请核查重要信息。') { break }
        if ($role) { [void]$body.Append($name) }
    }
    if ($role) { $messages.Add(@{ role = $role; text = $body.ToString() }) }
    return $messages.ToArray()
}

# 以最新回复的“重新生成”按钮确认生成结束；旧消息的按钮不计作本轮完成。
function Observe-Chat($window, $marker) {
    $messages = @(Read-Conversation $window)
    $assistantCount = 0
    $regenerate = Find-Named $window '重新生成回复' ([System.Windows.Automation.ControlType]::Button)
    $lastUser = ''
    $lastAssistant = ''
    $lastRole = ''
    $markerFound = $false
    foreach ($message in $messages) {
        $lastRole = $message.role
        if ($message.role -eq 'assistant') {
            $assistantCount++
            $lastAssistant = $message.text
        } else {
            $lastUser = $message.text
            if ($marker -and $message.text.Contains($marker)) { $markerFound = $true }
        }
    }
    $stops = Find-Named $window '停止生成' ([System.Windows.Automation.ControlType]::Button)
    $completed = $lastRole -eq 'assistant' -and $assistantCount -gt 0 -and
        $regenerate.Count -ge $assistantCount -and $stops.Count -eq 0
    return @{
        ok = $true
        messages = $messages
        assistantCount = $assistantCount
        lastUser = $lastUser
        lastAssistant = $lastAssistant
        lastRole = $lastRole
        markerFound = $markerFound
        complete = $completed
        generating = ($stops.Count -gt 0)
    }
}

# 新建独立聊天并确保处在“聊天”而非“工作”配额入口。
function Start-Chat($window) {
    Invoke-Button $window '新聊天'
    # 新标签页的撰写器模式按钮由网页异步渲染，定点查找会读到刚建出来还没画完的界面。
    $tabs = @(Wait-Named $window '撰写器模式' '聊天' ([System.Windows.Automation.ControlType]::Button) 8000)
    if ($tabs.Count -lt 1) { throw '新聊天界面缺少聊天模式切换按钮（等待 8 秒仍未出现）' }
    if ($tabs.Count -ne 1) { throw ('新聊天界面出现多个聊天模式切换按钮：' + $tabs.Count) }
    $toggle = $tabs[0].GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) {
        $toggle.Toggle()
        # 切换模式会重建输入区，等它重新渲染再取输入框。
        Start-Sleep -Milliseconds 200
    }
    $input = @(Wait-Named $window '' '询问 ChatGPT' ([System.Windows.Automation.ControlType]::Edit) 8000)
    if ($input.Count -ne 1) { throw ('官方客户端尚未进入可输入的聊天模式，输入框数量：' + $input.Count) }
    if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) {
        throw '官方客户端仍在工作模式，聊天模式切换未生效'
    }
    return @{ ok = $true; mode = 'chat' }
}

# 用无障碍输入值和发送按钮直接投递文本；不依赖已经耗尽额度的 Codex 模型操作界面。
function Send-Chat($window, $message, $sessionMarker, $messageMarker) {
    $before = Observe-Chat $window $sessionMarker
    if ($sessionMarker -and -not $before.markerFound) {
        throw '当前官方聊天不是 SpCode 已建立的会话，停止发送以免误投'
    }
    # 工作模式没有“询问 ChatGPT”编辑框，以输入框的准确名称核对路由。
    $inputs = Find-Named $window '询问 ChatGPT' ([System.Windows.Automation.ControlType]::Edit)
    if ($inputs.Count -ne 1) { throw '找不到官方聊天输入框' }
    $value = $inputs[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $value.SetValue($message)
    Start-Sleep -Milliseconds 120
    Invoke-Button $window '发送'
    # 官方客户端异步创建对话区，等消息标记真正出现在历史里再确认投递。
    $found = $false
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Milliseconds 200
        $after = Observe-Chat $window $messageMarker
        if ($after.markerFound) { $found = $true; break }
    }
    if (-not $found) { throw '聊天发送后未观察到消息标记，无法确认投递' }
    return @{ ok = $true; assistantCount = $before.assistantCount }
}

try {
    $line = [Console]::In.ReadLine()
    if (-not $line) { throw '缺少聊天 UI 指令' }
    $request = $line | ConvertFrom-Json
    $operation = [string]$request.action
    $window = Find-ChatWindow ($operation -eq 'start')
    if ($operation -eq 'start') {
        Send-Result (Start-Chat $window)
    } elseif ($operation -eq 'send') {
        Send-Result (Send-Chat $window ([string]$request.text) ([string]$request.sessionMarker) ([string]$request.messageMarker))
    } elseif ($operation -eq 'read') {
        Send-Result (Observe-Chat $window ([string]$request.sessionMarker))
    } elseif ($operation -eq 'stop') {
        $stops = Find-Named $window '停止生成' ([System.Windows.Automation.ControlType]::Button)
        if ($stops.Count -gt 0) {
            $stops[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        }
        Send-Result @{ ok = $true; stopped = ($stops.Count -gt 0) }
    } else {
        throw ('未知聊天 UI 指令：' + $operation)
    }
} catch {
    Send-Result @{ ok = $false; error = [string]$_.Exception.Message }
}
