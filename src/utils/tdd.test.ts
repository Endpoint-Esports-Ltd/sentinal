import { describe, expect, it } from "bun:test";
import {
  getExpectedTestPaths,
  getImplPathForTest,
  isGuardedFile,
  isTestFile,
  isTrivialEdit,
  shouldSkipTddGuard,
} from "./tdd";

describe("tdd utilities", () => {
  // ─── getExpectedTestPaths ─────────────────────────────────────────────────

  describe("getExpectedTestPaths", () => {
    // TypeScript / JavaScript
    it("should generate .spec.ts and .test.ts paths for a .ts file", () => {
      const paths = getExpectedTestPaths("/src/app/user.service.ts");
      expect(paths).toContain("/src/app/user.service.spec.ts");
      expect(paths).toContain("/src/app/user.service.test.ts");
    });

    it("should return empty for test files themselves", () => {
      expect(getExpectedTestPaths("/src/app/user.service.spec.ts")).toEqual([]);
    });

    it("should return empty for non-code files", () => {
      expect(getExpectedTestPaths("/src/index.html")).toEqual([]);
    });

    it("should return empty for module files", () => {
      expect(getExpectedTestPaths("/src/app/app.module.ts")).toEqual([]);
    });

    it("should return empty for DTOs", () => {
      expect(getExpectedTestPaths("/src/users/create-user.dto.ts")).toEqual([]);
    });

    it("should return empty for entities", () => {
      expect(getExpectedTestPaths("/src/users/user.entity.ts")).toEqual([]);
    });

    it("should generate .spec.tsx and .test.tsx paths for a .tsx file", () => {
      const paths = getExpectedTestPaths("/src/components/Button.tsx");
      expect(paths).toContain("/src/components/Button.spec.tsx");
      expect(paths).toContain("/src/components/Button.test.tsx");
    });

    it("should generate .spec.jsx and .test.jsx paths for a .jsx file", () => {
      const paths = getExpectedTestPaths("/src/components/Button.jsx");
      expect(paths).toContain("/src/components/Button.spec.jsx");
      expect(paths).toContain("/src/components/Button.test.jsx");
    });

    it("should return empty for .tsx test files themselves", () => {
      expect(getExpectedTestPaths("/src/components/Button.test.tsx")).toEqual(
        [],
      );
      expect(getExpectedTestPaths("/src/components/Button.spec.tsx")).toEqual(
        [],
      );
    });

    // Go
    it("should generate _test.go path for a .go file", () => {
      const paths = getExpectedTestPaths("/src/auth/auth.go");
      expect(paths).toEqual(["/src/auth/auth_test.go"]);
    });

    it("should return empty for Go test files", () => {
      expect(getExpectedTestPaths("/src/auth/auth_test.go")).toEqual([]);
    });

    it("should return empty for go.mod", () => {
      expect(getExpectedTestPaths("/project/go.mod")).toEqual([]);
    });

    // Python
    it("should generate test_*.py and *_test.py paths for a .py file", () => {
      const paths = getExpectedTestPaths("/src/auth/auth.py");
      expect(paths).toContain("/src/auth/test_auth.py");
      expect(paths).toContain("/src/auth/auth_test.py");
    });

    it("should return empty for Python test files (prefix)", () => {
      expect(getExpectedTestPaths("/src/auth/test_auth.py")).toEqual([]);
    });

    it("should return empty for Python test files (suffix)", () => {
      expect(getExpectedTestPaths("/src/auth/auth_test.py")).toEqual([]);
    });

    it("should return empty for __init__.py", () => {
      expect(getExpectedTestPaths("/src/auth/__init__.py")).toEqual([]);
    });

    it("should return empty for conftest.py", () => {
      expect(getExpectedTestPaths("/src/auth/conftest.py")).toEqual([]);
    });

    // Rust
    it("should generate _test.rs path for a .rs file", () => {
      const paths = getExpectedTestPaths("/src/auth.rs");
      expect(paths).toEqual(["/src/auth_test.rs"]);
    });

    it("should return empty for Rust test files", () => {
      expect(getExpectedTestPaths("/src/auth_test.rs")).toEqual([]);
    });

    it("should return empty for mod.rs", () => {
      expect(getExpectedTestPaths("/src/auth/mod.rs")).toEqual([]);
    });

    it("should return empty for lib.rs", () => {
      expect(getExpectedTestPaths("/src/lib.rs")).toEqual([]);
    });

    // C
    it("should generate test_*.c and *_test.c paths for a .c file", () => {
      const paths = getExpectedTestPaths("/src/auth.c");
      expect(paths).toContain("/src/test_auth.c");
      expect(paths).toContain("/src/auth_test.c");
    });

    it("should return empty for C test files (prefix)", () => {
      expect(getExpectedTestPaths("/src/test_auth.c")).toEqual([]);
    });

    it("should return empty for C test files (suffix)", () => {
      expect(getExpectedTestPaths("/src/auth_test.c")).toEqual([]);
    });

    // C++
    it("should generate test_*.cpp and *_test.cpp paths for a .cpp file", () => {
      const paths = getExpectedTestPaths("/src/auth.cpp");
      expect(paths).toContain("/src/test_auth.cpp");
      expect(paths).toContain("/src/auth_test.cpp");
    });

    it("should return empty for C++ test files", () => {
      expect(getExpectedTestPaths("/src/test_auth.cpp")).toEqual([]);
      expect(getExpectedTestPaths("/src/auth_test.cpp")).toEqual([]);
    });

    // Header files — not guarded
    it("should return empty for header files", () => {
      expect(getExpectedTestPaths("/src/auth.h")).toEqual([]);
      expect(getExpectedTestPaths("/src/auth.hpp")).toEqual([]);
    });
  });

  // ─── isTestFile ───────────────────────────────────────────────────────────

  describe("isTestFile", () => {
    // TS/JS
    it("should detect .spec.ts files", () => {
      expect(isTestFile("user.service.spec.ts")).toBe(true);
    });

    it("should detect .test.ts files", () => {
      expect(isTestFile("user.service.test.ts")).toBe(true);
    });

    it("should not detect regular .ts files", () => {
      expect(isTestFile("user.service.ts")).toBe(false);
    });

    it("should detect .test.tsx files", () => {
      expect(isTestFile("Button.test.tsx")).toBe(true);
    });

    it("should detect .spec.tsx files", () => {
      expect(isTestFile("Button.spec.tsx")).toBe(true);
    });

    it("should detect .test.jsx files", () => {
      expect(isTestFile("Button.test.jsx")).toBe(true);
    });

    it("should detect .spec.jsx files", () => {
      expect(isTestFile("Button.spec.jsx")).toBe(true);
    });

    it("should not detect regular .tsx files", () => {
      expect(isTestFile("Button.tsx")).toBe(false);
    });

    it("should not detect regular .jsx files", () => {
      expect(isTestFile("Button.jsx")).toBe(false);
    });

    // Go
    it("should detect Go _test.go files", () => {
      expect(isTestFile("auth_test.go")).toBe(true);
      expect(isTestFile("/src/auth/handler_test.go")).toBe(true);
    });

    it("should not detect regular .go files", () => {
      expect(isTestFile("auth.go")).toBe(false);
      expect(isTestFile("main.go")).toBe(false);
    });

    // Python
    it("should detect Python test_ prefix files", () => {
      expect(isTestFile("test_auth.py")).toBe(true);
      expect(isTestFile("/src/test_handler.py")).toBe(true);
    });

    it("should detect Python _test.py suffix files", () => {
      expect(isTestFile("auth_test.py")).toBe(true);
    });

    it("should not detect regular .py files", () => {
      expect(isTestFile("auth.py")).toBe(false);
      expect(isTestFile("__init__.py")).toBe(false);
    });

    // Rust
    it("should detect Rust _test.rs files", () => {
      expect(isTestFile("auth_test.rs")).toBe(true);
    });

    it("should not detect regular .rs files", () => {
      expect(isTestFile("auth.rs")).toBe(false);
      expect(isTestFile("mod.rs")).toBe(false);
    });

    // C/C++
    it("should detect C test files", () => {
      expect(isTestFile("test_auth.c")).toBe(true);
      expect(isTestFile("auth_test.c")).toBe(true);
    });

    it("should detect C++ test files", () => {
      expect(isTestFile("test_auth.cpp")).toBe(true);
      expect(isTestFile("auth_test.cpp")).toBe(true);
    });

    it("should not detect regular C/C++ files", () => {
      expect(isTestFile("auth.c")).toBe(false);
      expect(isTestFile("auth.cpp")).toBe(false);
    });
  });

  // ─── shouldSkipTddGuard ──────────────────────────────────────────────────

  describe("shouldSkipTddGuard — multi-language", () => {
    // Python
    it("should skip __init__.py", () => {
      expect(shouldSkipTddGuard("src/__init__.py")).toBe(true);
    });

    it("should skip conftest.py", () => {
      expect(shouldSkipTddGuard("src/conftest.py")).toBe(true);
    });

    it("should skip setup.py", () => {
      expect(shouldSkipTddGuard("setup.py")).toBe(true);
    });

    // Rust
    it("should skip mod.rs", () => {
      expect(shouldSkipTddGuard("src/auth/mod.rs")).toBe(true);
    });

    it("should skip lib.rs", () => {
      expect(shouldSkipTddGuard("src/lib.rs")).toBe(true);
    });

    // Go
    it("should skip go.mod", () => {
      expect(shouldSkipTddGuard("go.mod")).toBe(true);
    });

    it("should skip go.sum", () => {
      expect(shouldSkipTddGuard("go.sum")).toBe(true);
    });

    it("should NOT skip main.go", () => {
      expect(shouldSkipTddGuard("main.go")).toBe(false);
    });

    // Build files
    it("should skip Makefile", () => {
      expect(shouldSkipTddGuard("Makefile")).toBe(true);
    });

    it("should skip CMakeLists.txt", () => {
      expect(shouldSkipTddGuard("CMakeLists.txt")).toBe(true);
    });
  });

  // ─── isGuardedFile ────────────────────────────────────────────────────────

  describe("isGuardedFile", () => {
    // Should guard
    it("should guard .ts implementation files", () => {
      expect(isGuardedFile("src/auth.ts")).toBe(true);
    });

    it("should guard .go implementation files", () => {
      expect(isGuardedFile("src/auth.go")).toBe(true);
    });

    it("should guard .py implementation files", () => {
      expect(isGuardedFile("src/auth.py")).toBe(true);
    });

    it("should guard .rs implementation files", () => {
      expect(isGuardedFile("src/auth.rs")).toBe(true);
    });

    it("should guard .c implementation files", () => {
      expect(isGuardedFile("src/auth.c")).toBe(true);
    });

    it("should guard .cpp implementation files", () => {
      expect(isGuardedFile("src/auth.cpp")).toBe(true);
    });

    // Should NOT guard
    it("should not guard test files", () => {
      expect(isGuardedFile("src/auth.test.ts")).toBe(false);
      expect(isGuardedFile("src/auth_test.go")).toBe(false);
      expect(isGuardedFile("src/test_auth.py")).toBe(false);
      expect(isGuardedFile("src/auth_test.rs")).toBe(false);
      expect(isGuardedFile("src/test_auth.c")).toBe(false);
    });

    it("should not guard skipped files", () => {
      expect(isGuardedFile("src/app.module.ts")).toBe(false);
      expect(isGuardedFile("src/__init__.py")).toBe(false);
      expect(isGuardedFile("src/mod.rs")).toBe(false);
      expect(isGuardedFile("go.mod")).toBe(false);
    });

    it("should not guard non-code files", () => {
      expect(isGuardedFile("README.md")).toBe(false);
      expect(isGuardedFile("styles.css")).toBe(false);
      expect(isGuardedFile("index.html")).toBe(false);
    });

    it("should not guard header files", () => {
      expect(isGuardedFile("src/auth.h")).toBe(false);
      expect(isGuardedFile("src/auth.hpp")).toBe(false);
    });
  });

  // ─── getImplPathForTest ───────────────────────────────────────────────────

  describe("getImplPathForTest", () => {
    // TS/JS (existing)
    it("should map .test.ts to .ts", () => {
      expect(getImplPathForTest("src/foo/bar.test.ts")).toBe("src/foo/bar.ts");
    });

    it("should map .spec.ts to .ts", () => {
      expect(getImplPathForTest("src/foo/bar.spec.ts")).toBe("src/foo/bar.ts");
    });

    it("should map .test.tsx to .tsx", () => {
      expect(getImplPathForTest("src/Button.test.tsx")).toBe("src/Button.tsx");
    });

    it("should map .test.js to .js", () => {
      expect(getImplPathForTest("src/foo/bar.test.js")).toBe("src/foo/bar.js");
    });

    // Go
    it("should map _test.go to .go", () => {
      expect(getImplPathForTest("src/auth/auth_test.go")).toBe(
        "src/auth/auth.go",
      );
    });

    // Python suffix
    it("should map _test.py to .py", () => {
      expect(getImplPathForTest("src/auth/auth_test.py")).toBe(
        "src/auth/auth.py",
      );
    });

    // Python prefix
    it("should map test_*.py to *.py", () => {
      expect(getImplPathForTest("src/auth/test_auth.py")).toBe(
        "src/auth/auth.py",
      );
    });

    // Rust
    it("should map _test.rs to .rs", () => {
      expect(getImplPathForTest("src/auth_test.rs")).toBe("src/auth.rs");
    });

    // C suffix
    it("should map _test.c to .c", () => {
      expect(getImplPathForTest("src/auth_test.c")).toBe("src/auth.c");
    });

    // C prefix
    it("should map test_*.c to *.c", () => {
      expect(getImplPathForTest("src/test_auth.c")).toBe("src/auth.c");
    });

    // C++ suffix
    it("should map _test.cpp to .cpp", () => {
      expect(getImplPathForTest("src/auth_test.cpp")).toBe("src/auth.cpp");
    });

    // C++ prefix
    it("should map test_*.cpp to *.cpp", () => {
      expect(getImplPathForTest("src/test_auth.cpp")).toBe("src/auth.cpp");
    });

    // Non-test
    it("should return null for non-test files", () => {
      expect(getImplPathForTest("src/foo/bar.ts")).toBeNull();
      expect(getImplPathForTest("src/auth.go")).toBeNull();
      expect(getImplPathForTest("src/auth.py")).toBeNull();
    });
  });

  // ─── isTrivialEdit ────────────────────────────────────────────────────────

  describe("isTrivialEdit", () => {
    it("should detect import-only changes", () => {
      expect(isTrivialEdit("import { Foo } from './foo';")).toBe(true);
    });

    it("should not detect function changes as trivial", () => {
      expect(isTrivialEdit("function doSomething() { return 1; }")).toBe(false);
    });
  });
});
