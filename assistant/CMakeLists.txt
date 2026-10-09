cmake_minimum_required(VERSION 3.20)

project(codex_phone_assistant VERSION 1.0.1 LANGUAGES CXX RC)

if(NOT WIN32)
    message(FATAL_ERROR "Codex Phone Assistant only supports Windows.")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_library(phone-manager-client STATIC
    src/PhoneManagerClient.cpp
    src/PhoneManagerClient.h
    src/management/Common.cpp
    src/management/Settings.cpp
    src/management/Editors.cpp
    src/management/Windows.cpp
    src/management/Observation.cpp
    src/management/Lifecycle.cpp
    src/management/Manager.cpp
)
target_include_directories(phone-manager-client PUBLIC src)
target_include_directories(phone-manager-client SYSTEM PUBLIC third_party)
target_compile_definitions(phone-manager-client PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
)
target_compile_options(phone-manager-client PRIVATE
    $<$<CXX_COMPILER_ID:MSVC>:/W4 /permissive- /utf-8 /EHsc>
)
target_link_libraries(phone-manager-client PUBLIC crypt32 bcrypt winhttp iphlpapi ws2_32 user32 shell32)

add_executable(codex-phone-assistant WIN32
    src/main.cpp
    resources/app.rc
    resources/app.manifest
)
target_compile_definitions(codex-phone-assistant PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
)
target_include_directories(codex-phone-assistant PRIVATE resources)
target_compile_options(codex-phone-assistant PRIVATE
    $<$<CXX_COMPILER_ID:MSVC>:/W4 /permissive- /utf-8 /EHsc>
)
target_link_libraries(codex-phone-assistant PRIVATE
    phone-manager-client
    comctl32
    d2d1
    dwrite
    gdi32
    user32
    shell32
)
set_target_properties(codex-phone-assistant PROPERTIES
    OUTPUT_NAME "CodexPhoneAssistant"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
)

enable_testing()
add_executable(phone-assistant-tests
    ../tests/assistant/PhoneManagerClientTests.cpp
)
target_compile_definitions(phone-assistant-tests PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
)
target_compile_options(phone-assistant-tests PRIVATE
    $<$<CXX_COMPILER_ID:MSVC>:/W4 /permissive- /utf-8 /EHsc>
)
target_link_libraries(phone-assistant-tests PRIVATE phone-manager-client)
set_target_properties(phone-assistant-tests PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}"
)
add_test(NAME manager-output-parser COMMAND phone-assistant-tests)

add_executable(phone-manager-tests ../tests/assistant/ManagerCoreTests.cpp)
target_compile_definitions(phone-manager-tests PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(phone-manager-tests PRIVATE $<$<CXX_COMPILER_ID:MSVC>:/W4 /utf-8 /EHsc>)
target_link_libraries(phone-manager-tests PRIVATE phone-manager-client)
add_test(NAME native-manager-core COMMAND phone-manager-tests)

add_executable(phone-manager-fixture ../tests/assistant/ManagerFixture.cpp)
target_compile_definitions(phone-manager-fixture PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_compile_options(phone-manager-fixture PRIVATE $<$<CXX_COMPILER_ID:MSVC>:/W4 /utf-8 /EHsc>)
target_link_libraries(phone-manager-fixture PRIVATE phone-manager-client)

install(TARGETS codex-phone-assistant RUNTIME DESTINATION .)
