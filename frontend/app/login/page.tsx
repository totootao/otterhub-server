"use client";

import { Suspense, useState } from "react";
import { login } from "@/lib/api";
import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Lock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { Footer } from "@/components/footer";
import { APP_NAME, APP_TAGLINE } from "@/lib/ui-text";

type LoginFormValues = {
  password: string;
};

function LoginContent() {
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  // 获取重定向 URL，默认跳转到首页
  const getRedirectUrl = () => {
    const redirect = searchParams.get("redirect");
    // 安全检查：确保重定向 URL 是站内地址
    if (
      redirect &&
      (redirect.startsWith("/") || redirect.startsWith(window.location.origin))
    ) {
      return redirect;
    }
    return "/";
  };

  const form = useForm<LoginFormValues>({
    defaultValues: {
      password: "",
    },
  });

  const onSubmit = async (values: LoginFormValues) => {
    if (loading) return;
    setLoading(true);
    try {
      const success = await login(values.password);
      if (!success) {
        throw new Error("登录失败，请检查密码");
      }
      toast.success("登录成功");
      const redirectUrl = getRedirectUrl();
      router.push(redirectUrl);
    } catch (err: any) {
      console.error("Login failed:", err);
      toast.error(err.message || "登录失败，请检查密码");
    } finally {
      setLoading(false);
    }
  };
  const submitLogin = form.handleSubmit(onSubmit);

  return (
    <div className="flex-1 flex flex-col items-center justify-center w-full max-w-[320px] z-10 animate-in fade-in zoom-in duration-700">
      <div className="flex flex-col items-center mb-10">
        <div className="w-20 h-20 rounded-3xl bg-linear-to-br from-primary to-accent flex items-center justify-center text-5xl shadow-2xl shadow-primary/30 mb-6 animate-bounce">
          🦦
        </div>
        <h1 className="text-4xl font-black text-foreground tracking-tighter">
          {APP_NAME}
        </h1>
        <p className="text-foreground/50 text-sm font-medium mt-2 tracking-widest uppercase">
          {APP_TAGLINE}
        </p>
      </div>

      <Form {...form}>
        <form onSubmit={submitLogin} className="w-full space-y-4">
          <FormField
            control={form.control}
            name="password"
            rules={{ required: "请输入密码" }}
            render={({ field }) => (
              <FormItem className="space-y-0">
                <FormControl>
                  <div className="relative group">
                    <Lock className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-foreground/30 group-focus-within:text-primary transition-colors" />
                    <Input
                      type="password"
                      placeholder="请输入访问密码"
                      className="h-12 pl-11 bg-glass-bg border-glass-border backdrop-blur-md text-foreground placeholder:text-foreground/30 focus-visible:ring-primary/50 transition-all rounded-2xl"
                      disabled={loading}
                      onKeyDown={(event) => {
                        if (
                          event.key !== "Enter" ||
                          event.nativeEvent.isComposing ||
                          loading
                        ) {
                          return;
                        }
                        event.preventDefault();
                        submitLogin();
                      }}
                      {...field}
                    />
                  </div>
                </FormControl>
                <FormMessage className="text-center mt-2 text-xs" />
              </FormItem>
            )}
          />
          <Button
            type="submit"
            className="w-full h-12 rounded-2xl bg-foreground text-background hover:opacity-90 transition-all font-bold text-base shadow-xl"
            disabled={loading}
          >
            {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "登录"}
          </Button>
        </form>
      </Form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className="relative min-h-screen flex flex-col items-center justify-between p-6 bg-linear-to-br from-gradient-from via-gradient-via to-gradient-to overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/20 rounded-full blur-[120px] animate-pulse" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-accent/20 rounded-full blur-[120px] animate-pulse delay-700" />

      <Suspense
        fallback={
          <div className="flex-1 flex flex-col items-center justify-center w-full max-w-[320px] z-10">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        }
      >
        <LoginContent />
      </Suspense>

      <div className="relative z-10 opacity-60 hover:opacity-100 transition-opacity">
        <Footer />
      </div>
    </div>
  );
}
