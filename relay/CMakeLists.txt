cmake_minimum_required(VERSION 3.20)
project(codex_phone_relay VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(relay-server src/main.cpp)
target_compile_definitions(relay-server PRIVATE UNICODE _UNICODE)
target_compile_options(relay-server PRIVATE /W4 /permissive- /utf-8 /EHsc)
target_link_libraries(relay-server PRIVATE ws2_32 bcrypt advapi32 shell32)

install(TARGETS relay-server RUNTIME DESTINATION .)
